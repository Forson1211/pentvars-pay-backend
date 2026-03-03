import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { StudentFee } from '../models/StudentFee';
import { FeeItem } from '../models/FeeItem';
import { FeeCalculationService } from '../services/feeCalculationService';
import { PaystackService } from '../services/paystackService';
import { Transaction } from '../models/Transaction';
import { AuditLog } from '../models/AuditLog';
import { generateReference } from '../utils/helpers';

/**
 * USSD Session state stored in memory (use Redis for production multi-server)
 * Key: sessionId, Value: session state
 */
interface USSDSession {
    studentId?: string;
    studentDbId?: string;
    step: string;
    feeType?: string;
    feeItemId?: string;
    studentFeeId?: string;
    amount?: number;
    mobileNetwork?: 'mtn' | 'vodafone' | 'airtel' | 'tigo';
    reference?: string;
    createdAt: Date;
}

const sessions = new Map<string, USSDSession>();

// Clean up stale sessions every 10 minutes
setInterval(() => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes
    for (const [key, session] of sessions.entries()) {
        if (session.createdAt < cutoff) sessions.delete(key);
    }
}, 10 * 60 * 1000);

/**
 * Build a USSD response
 */
function ussdResponse(message: string, continueSession: boolean = true): { message: string; continueSession: boolean } {
    return { message, continueSession };
}

/**
 * POST /api/ussd/session
 * 
 * Main USSD handler. Called by the telecom gateway for each USSD interaction.
 * 
 * Expected body (Africa's Talking USSD format):
 * {
 *   sessionId: string,    // unique session ID per USSD session
 *   serviceCode: string,  // USSD code e.g. *920#
 *   phoneNumber: string,  // MSISDN of user e.g. +233241234567
 *   text: string          // accumulated user input e.g. "2" or "1*2"
 * }
 * 
 * USSD Menu:
 * 1. Pay Academic Fee
 * 2. Pay Hostel Fee
 * 3. Pay Resit Fee
 * 4. Pay Supplementary Fee
 * 5. Check Balance
 */
export const handleUSSDSession = async (req: Request, res: Response): Promise<void> => {
    const { sessionId, serviceCode, phoneNumber, text } = req.body;

    if (!sessionId || !phoneNumber) {
        res.status(400).json({ message: 'Invalid USSD request' });
        return;
    }

    // Get or create session
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { step: 'main_menu', createdAt: new Date() });
    }
    const session = sessions.get(sessionId)!;

    // Parse user input (Africa's Talking sends accumulated inputs separated by *)
    const inputs = text ? text.split('*') : [];
    const lastInput = inputs[inputs.length - 1] || '';

    try {
        // ── MAIN MENU ─────────────────────────────────────────────────────
        if (text === '' || session.step === 'main_menu') {
            session.step = 'awaiting_student_id';
            sessions.set(sessionId, session);

            const menu = [
                'CON Welcome to PentVars Pay',
                'Enter your Student ID:',
            ].join('\n');
            res.json(ussdResponse(menu));
            return;
        }

        // ── STUDENT ID ENTRY ───────────────────────────────────────────────
        if (session.step === 'awaiting_student_id') {
            const studentIdInput = lastInput.trim().toUpperCase();

            const student = await User.findOne({ studentId: studentIdInput, role: 'student', status: 'active' });
            if (!student) {
                sessions.delete(sessionId);
                const msg = 'END Student ID not found. Please check your ID and try again.';
                res.json(ussdResponse(msg, false));
                return;
            }

            session.studentId = studentIdInput;
            session.studentDbId = student.id.toString();
            session.step = 'main_menu_options';
            sessions.set(sessionId, session);

            await AuditLog.create({
                action: 'ussd_session_started',
                studentId: student.id,
                ip: req.ip,
                channel: 'ussd',
                details: { phoneNumber, serviceCode },
                isError: false,
            }).catch(console.error);

            const options = [
                `CON Welcome, ${student.firstName}!`,
                `ID: ${student.studentId}`,
                '',
                '1. Pay Academic Fee',
                student.hostelOption ? '2. Pay Hostel Fee' : null,
                '3. Pay Resit Fee',
                '4. Pay Supplementary Fee',
                '5. Check Balance',
            ].filter(Boolean).join('\n');

            res.json(ussdResponse(options));
            return;
        }

        // ── MAIN MENU OPTIONS ─────────────────────────────────────────────
        if (session.step === 'main_menu_options') {
            const student = await User.findById(session.studentDbId);
            if (!student) {
                sessions.delete(sessionId);
                res.json(ussdResponse('END Session expired. Please try again.', false));
                return;
            }

            switch (lastInput) {
                case '1': // Academic Fee
                    session.feeType = 'academic';
                    session.step = 'confirm_academic';
                    sessions.set(sessionId, session);
                    await sendAcademicFeeInfo(session, student, res);
                    return;

                case '2': // Hostel Fee
                    if (!student.hostelOption) {
                        res.json(ussdResponse('END You are not eligible for hostel fee payment.', false));
                        return;
                    }
                    session.feeType = 'hostel';
                    session.step = 'select_hostel_fee';
                    sessions.set(sessionId, session);
                    await sendHostelFeeInfo(session, student, res);
                    return;

                case '3': // Resit Fee
                    session.feeType = 'resit';
                    session.step = 'select_resit_fee';
                    sessions.set(sessionId, session);
                    await sendResitFeeInfo(session, student, res);
                    return;

                case '4': // Supplementary Fee
                    session.feeType = 'supplementary';
                    session.step = 'select_supplementary_fee';
                    sessions.set(sessionId, session);
                    await sendSupplementaryFeeInfo(session, student, res);
                    return;

                case '5': // Check Balance
                    session.step = 'check_balance';
                    sessions.set(sessionId, session);
                    await sendBalanceInfo(session, student, res);
                    return;

                default:
                    res.json(ussdResponse('CON Invalid option. Please try again.\n\n1. Pay Academic Fee\n2. Pay Hostel Fee\n3. Pay Resit Fee\n4. Pay Supplementary Fee\n5. Check Balance'));
                    return;
            }
        }

        // ── CONFIRM ACADEMIC FEE ──────────────────────────────────────────
        if (session.step === 'confirm_academic') {
            if (lastInput === '1') {
                session.step = 'select_network';
                sessions.set(sessionId, session);
                res.json(ussdResponse('CON Select payment method:\n1. MTN Mobile Money\n2. Vodafone Cash\n3. Airtel Money\n4. Tigo Cash\n5. Card/Bank Transfer'));
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                res.json(ussdResponse('END Payment cancelled.', false));
            } else {
                res.json(ussdResponse('CON Press 1 to confirm or 2 to cancel'));
            }
            return;
        }

        // ── CONFIRM HOSTEL FEE ────────────────────────────────────────────
        if (session.step === 'confirm_hostel') {
            if (lastInput === '1') {
                session.step = 'select_network';
                sessions.set(sessionId, session);
                res.json(ussdResponse('CON Select payment method:\n1. MTN Mobile Money\n2. Vodafone Cash\n3. Airtel Money\n4. Tigo Cash\n5. Card/Bank Transfer'));
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                res.json(ussdResponse('END Payment cancelled.', false));
            } else {
                res.json(ussdResponse('CON Press 1 to confirm or 2 to cancel'));
            }
            return;
        }

        // ── CONFIRM RESIT FEE ─────────────────────────────────────────────
        if (session.step === 'confirm_resit') {
            if (lastInput === '1') {
                session.step = 'select_network';
                sessions.set(sessionId, session);
                res.json(ussdResponse('CON Select payment method:\n1. MTN Mobile Money\n2. Vodafone Cash\n3. Airtel Money\n4. Tigo Cash\n5. Card/Bank Transfer'));
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                res.json(ussdResponse('END Payment cancelled.', false));
            } else {
                res.json(ussdResponse('CON Press 1 to confirm or 2 to cancel'));
            }
            return;
        }

        // ── CONFIRM SUPPLEMENTARY FEE ─────────────────────────────────────
        if (session.step === 'confirm_supplementary') {
            if (lastInput === '1') {
                session.step = 'select_network';
                sessions.set(sessionId, session);
                res.json(ussdResponse('CON Select payment method:\n1. MTN Mobile Money\n2. Vodafone Cash\n3. Airtel Money\n4. Tigo Cash\n5. Card/Bank Transfer'));
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                res.json(ussdResponse('END Payment cancelled.', false));
            } else {
                res.json(ussdResponse('CON Press 1 to confirm or 2 to cancel'));
            }
            return;
        }

        // ── NETWORK SELECTION & PAYMENT ────────────────────────────────────
        if (session.step === 'select_network') {
            const networkMap: Record<string, 'mtn' | 'vodafone' | 'airtel' | 'tigo'> = {
                '1': 'mtn',
                '2': 'vodafone',
                '3': 'airtel',
                '4': 'tigo',
            };

            if (!['1', '2', '3', '4', '5'].includes(lastInput)) {
                res.json(ussdResponse('CON Invalid option.\n1. MTN Mobile Money\n2. Vodafone Cash\n3. Airtel Money\n4. Tigo Cash\n5. Card/Bank Transfer'));
                return;
            }

            session.mobileNetwork = networkMap[lastInput] || 'mtn';
            session.step = 'enter_phone';
            sessions.set(sessionId, session);

            if (lastInput === '5') {
                // Card/Bank Transfer — send authorization URL via SMS
                await processUSSDPayment(session, phoneNumber, res, 'bank_transfer');
            } else {
                res.json(ussdResponse(`CON Enter your ${session.mobileNetwork?.toUpperCase()} phone number:\n(e.g. 0241234567)`));
            }
            return;
        }

        // ── PHONE NUMBER ENTRY ────────────────────────────────────────────
        if (session.step === 'enter_phone') {
            const phone = lastInput.trim();
            if (!/^0[0-9]{9}$/.test(phone)) {
                res.json(ussdResponse('CON Invalid phone number. Enter a valid 10-digit number:'));
                return;
            }

            // Convert to international format for Paystack: 0244123456 → 233244123456
            const intlPhone = `233${phone.substring(1)}`;

            await processUSSDMoMoPayment(session, intlPhone, res);
            return;
        }

        // ── BALANCE CHECK ──────────────────────────────────────────────────
        if (session.step === 'check_balance') {
            sessions.delete(sessionId);
            res.json(ussdResponse('END Thank you for checking your balance.', false));
            return;
        }

        // Default
        sessions.delete(sessionId);
        res.json(ussdResponse('END Session ended. Please dial again.', false));

    } catch (error: any) {
        console.error('[USSD] Error:', error);
        sessions.delete(sessionId);
        res.json(ussdResponse('END An error occurred. Please try again later.', false));
    }
};

// ─── Fee Info Helpers ─────────────────────────────────────────────────────────

async function sendAcademicFeeInfo(session: USSDSession, student: any, res: Response): Promise<void> {
    try {
        // Get or create student fee (semester 1 first, then 2)
        let studentFee = null;
        try { studentFee = await FeeCalculationService.getOrCreateStudentFee(student, 1); } catch { }
        if (!studentFee || studentFee.status === 'paid') {
            try { studentFee = await FeeCalculationService.getOrCreateStudentFee(student, 2); } catch { }
        }

        if (!studentFee || studentFee.status === 'paid') {
            sessions.delete(session.step);
            res.json(ussdResponse('END Your academic fees are fully paid. Thank you!', false));
            return;
        }

        session.studentFeeId = studentFee.id.toString();
        session.amount = studentFee.balance;
        session.step = 'confirm_academic';

        const msg = [
            `CON Academic Fee Details`,
            `Semester: ${studentFee.semester}`,
            `Total: GHS ${studentFee.totalFee.toFixed(2)}`,
            `Paid: GHS ${studentFee.amountPaid.toFixed(2)}`,
            `Balance: GHS ${studentFee.balance.toFixed(2)}`,
            '',
            '1. Pay Now',
            '2. Cancel',
        ].join('\n');

        res.json(ussdResponse(msg));
    } catch (error: any) {
        res.json(ussdResponse(`END Error: ${error.message}`, false));
    }
}

async function sendHostelFeeInfo(session: USSDSession, student: any, res: Response): Promise<void> {
    const hostelFees = await FeeItem.find({
        studentId: student.id,
        status: { $in: ['pending', 'partial'] },
    }).populate({ path: 'feeTypeId', match: { category: 'hostel' } });

    const eligible = hostelFees.filter(f => f.feeTypeId);

    if (eligible.length === 0) {
        res.json(ussdResponse('END No hostel fee record found. Contact administration.', false));
        return;
    }

    const fee = eligible[0];
    const feeType = fee.feeTypeId as any;
    session.feeItemId = fee.id.toString();
    session.amount = fee.balance;
    session.step = 'confirm_hostel';

    const msg = [
        `CON Hostel Fee`,
        `${feeType?.name || 'Hostel'}`,
        `Balance: GHS ${fee.balance.toFixed(2)}`,
        '',
        '1. Pay Now',
        '2. Cancel',
    ].join('\n');

    res.json(ussdResponse(msg));
}

async function sendResitFeeInfo(session: USSDSession, student: any, res: Response): Promise<void> {
    const fees = await FeeItem.find({
        studentId: student.id,
        status: { $in: ['pending', 'partial'] },
    }).populate({ path: 'feeTypeId', match: { category: 'resit' } });

    const eligible = fees.filter(f => f.feeTypeId);

    if (eligible.length === 0) {
        res.json(ussdResponse('END No resit fee record found. Contact examination office.', false));
        return;
    }

    const fee = eligible[0];
    const feeType = fee.feeTypeId as any;
    session.feeItemId = fee.id.toString();
    session.amount = fee.balance;
    session.step = 'confirm_resit';

    const msg = [
        `CON Resit Fee`,
        `${feeType?.name || 'Resit'}`,
        `Balance: GHS ${fee.balance.toFixed(2)}`,
        '',
        '1. Pay Now',
        '2. Cancel',
    ].join('\n');

    res.json(ussdResponse(msg));
}

async function sendSupplementaryFeeInfo(session: USSDSession, student: any, res: Response): Promise<void> {
    const fees = await FeeItem.find({
        studentId: student.id,
        status: { $in: ['pending', 'partial'] },
    }).populate({ path: 'feeTypeId', match: { category: 'supplementary' } });

    const eligible = fees.filter(f => f.feeTypeId);

    if (eligible.length === 0) {
        res.json(ussdResponse('END No supplementary fee record found. Contact examination office.', false));
        return;
    }

    const fee = eligible[0];
    const feeType = fee.feeTypeId as any;
    session.feeItemId = fee.id.toString();
    session.amount = fee.balance;
    session.step = 'confirm_supplementary';

    const msg = [
        `CON Supplementary Fee`,
        `${feeType?.name || 'Supplementary'}`,
        `Balance: GHS ${fee.balance.toFixed(2)}`,
        '',
        '1. Pay Now',
        '2. Cancel',
    ].join('\n');

    res.json(ussdResponse(msg));
}

async function sendBalanceInfo(session: USSDSession, student: any, res: Response): Promise<void> {
    const [academicFees, feeItems] = await Promise.all([
        StudentFee.find({ student: student.id, status: { $in: ['unpaid', 'partial'] } }).populate('academicYear'),
        FeeItem.find({ studentId: student.id, status: { $in: ['pending', 'partial'] } }).populate('feeTypeId'),
    ]);

    const academicBalance = academicFees.reduce((sum, f) => sum + f.balance, 0);
    const optionalBalance = feeItems.reduce((sum, f) => sum + f.balance, 0);
    const totalBalance = academicBalance + optionalBalance;

    const lines = [
        'END Balance Summary:',
        `Academic: GHS ${academicBalance.toFixed(2)}`,
    ];

    feeItems.forEach(f => {
        const ft = f.feeTypeId as any;
        lines.push(`${ft?.name || 'Fee'}: GHS ${f.balance.toFixed(2)}`);
    });

    lines.push('', `TOTAL: GHS ${totalBalance.toFixed(2)}`);

    res.json(ussdResponse(lines.join('\n'), false));
}

// ─── Payment Processing ───────────────────────────────────────────────────────

async function processUSSDMoMoPayment(session: USSDSession, intlPhone: string, res: Response): Promise<void> {
    const student = await User.findById(session.studentDbId);
    if (!student || !session.amount) {
        res.json(ussdResponse('END Session error. Please try again.', false));
        return;
    }

    const reference = generateReference('USSD');
    const category = session.feeType as any || 'academic';
    let description = `USSD ${category} fee payment`;

    try {
        // Create pending transaction
        const transaction = await Transaction.create({
            studentId: student.id,
            feeItemId: session.feeItemId || undefined,
            studentFeeId: session.studentFeeId || undefined,
            amount: session.amount,
            amountExpected: session.amount,
            paymentMethod: 'mobile_money',
            paymentChannel: 'ussd',
            status: 'pending',
            reference,
            category,
            description,
            phoneNumber: intlPhone,
            webhookVerified: false,
            metadata: { intlPhone, network: session.mobileNetwork, channel: 'ussd' },
        });

        // Charge via Paystack
        const chargeResult = await PaystackService.chargeMobileMoney(
            session.amount,
            student.email,
            reference,
            intlPhone,
            session.mobileNetwork || 'mtn',
            { studentId: student.studentId, category, description, transactionId: transaction.id }
        );

        await AuditLog.create({
            action: 'ussd_payment_initiated',
            reference,
            studentId: student.id,
            amount: session.amount,
            category,
            channel: 'ussd-momo',
            details: { network: session.mobileNetwork, chargeStatus: chargeResult?.status },
            isError: false,
        }).catch(console.error);

        sessions.delete(session.step);

        if (chargeResult?.status) {
            res.json(ussdResponse(
                `END Payment of GHS ${session.amount?.toFixed(2)} initiated.\nRef: ${reference}\nApprove the prompt on your phone.\nYou will receive an SMS confirmation.`,
                false
            ));
        } else {
            res.json(ussdResponse(`END Payment failed: ${chargeResult?.message || 'Unknown error'}. Try again.`, false));
        }
    } catch (error: any) {
        console.error('[USSD] MoMo payment error:', error);
        res.json(ussdResponse(`END Payment error: ${error.message}. Please try again.`, false));
    }
}

async function processUSSDPayment(session: USSDSession, phoneNumber: string, res: Response, method: string): Promise<void> {
    const student = await User.findById(session.studentDbId);
    if (!student || !session.amount) {
        res.json(ussdResponse('END Session error. Please try again.', false));
        return;
    }

    const reference = generateReference('USSD');
    const category = session.feeType as any || 'academic';

    try {
        const psResponse = await PaystackService.initializeTransaction(
            session.amount,
            student.email,
            reference,
            { studentId: student.studentId, category, channel: 'ussd' }
        );

        await Transaction.create({
            studentId: student.id,
            feeItemId: session.feeItemId || undefined,
            studentFeeId: session.studentFeeId || undefined,
            amount: session.amount,
            amountExpected: session.amount,
            paymentMethod: 'bank_transfer',
            paymentChannel: 'ussd',
            status: 'pending',
            reference,
            category,
            description: `USSD ${category} fee payment`,
            webhookVerified: false,
            paystackAuthorizationUrl: psResponse.data?.authorization_url,
            paystackAccessCode: psResponse.data?.access_code,
        });

        sessions.delete(session.step);

        res.json(ussdResponse(
            `END Payment link sent.\nVisit: ${psResponse.data?.authorization_url || 'Check SMS'}\nRef: ${reference}\nAmnt: GHS ${session.amount.toFixed(2)}`,
            false
        ));
    } catch (error: any) {
        res.json(ussdResponse(`END Error: ${error.message}`, false));
    }
}

/**
 * GET /api/ussd/menu
 * Returns the USSD menu structure (for testing/documentation)
 */
export const getUSSDMenu = async (req: Request, res: Response): Promise<void> => {
    res.json({
        serviceCode: '*920*1#', // Replace with your actual USSD code
        menu: {
            main: ['1. Pay Academic Fee', '2. Pay Hostel Fee', '3. Pay Resit Fee', '4. Pay Supplementary Fee', '5. Check Balance'],
            paymentMethods: ['1. MTN Mobile Money', '2. Vodafone Cash', '3. Airtel Money', '4. Tigo Cash', '5. Card/Bank Transfer'],
        },
        description: 'PentVars Pay USSD Service for Pentecost University students',
    });
};
