import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { StudentFee } from '../models/StudentFee';
import { FeeItem } from '../models/FeeItem';
import { FeeType } from '../models/FeeType';
import { FeeCalculationService } from '../services/feeCalculationService';
import { PaystackService } from '../services/paystackService';
import { Transaction } from '../models/Transaction';
import { AuditLog } from '../models/AuditLog';
import { generateReference } from '../utils/helpers';
import { config } from '../config/env';
import { finalizePaymentSuccess } from './paymentController';

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
    mobileNetwork?: 'mtn' | 'vod' | 'atl';
    reference?: string;
    pendingOtpReference?: string; // set when Paystack returns send_otp
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
 * Send a USSD response in the correct format for telecom gateways.
 *
 * Africa's Talking expects:
 *   Content-Type: text/plain
 *   Body starts with "CON " (continue) or "END " (terminate)
 *
 * The message MUST already include the CON/END prefix.
 */
function sendUSSD(res: Response, message: string): void {
    const req = res.req as Request | undefined;
    const isArkesel = !!(req && req.body && (
        req.body.msisdn !== undefined || 
        req.body.sessionID !== undefined || 
        req.body.userData !== undefined || 
        req.body.userID !== undefined
    ));

    if (isArkesel && req) {
        let continueSession = true;
        let cleanMessage = message;

        if (message.startsWith('CON ')) {
            continueSession = true;
            cleanMessage = message.substring(4);
        } else if (message.startsWith('END ')) {
            continueSession = false;
            cleanMessage = message.substring(4);
        } else {
            continueSession = false;
        }

        res.set('Content-Type', 'application/json');
        res.json({
            sessionID: req.body.sessionID || req.body.sessionId || '',
            userID: req.body.userID || '',
            msisdn: req.body.msisdn || req.body.phoneNumber || '',
            message: cleanMessage,
            continueSession: continueSession
        });
    } else {
        res.set('Content-Type', 'text/plain');
        res.send(message);
    }
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
    // Extract fields, supporting both Africa's Talking / Simulator and Arkesel formats
    const sessionID = req.body.sessionID || req.body.sessionId;
    const msisdn = req.body.msisdn || req.body.phoneNumber;
    const userDataRaw = req.body.userData !== undefined ? req.body.userData : req.body.text;
    const userData = userDataRaw !== undefined && userDataRaw !== null ? String(userDataRaw) : null;
    const serviceCodeRaw = req.body.serviceCode;
    const serviceCode = serviceCodeRaw !== undefined && serviceCodeRaw !== null ? String(serviceCodeRaw) : undefined;

    // Detect mobile network from Arkesel's 'network' field (e.g. 'MTN', 'AIRTELTIGO', 'TELECEL')
    const arkeselNetwork: string | undefined = req.body.network ? String(req.body.network).toUpperCase() : undefined;
    const arkeselNetworkMap: Record<string, 'mtn' | 'vod' | 'atl'> = {
        'MTN': 'mtn',
        'AIRTELTIGO': 'atl',
        'AIRTEL': 'atl',
        'TIGO': 'atl',
        'VODAFONE': 'vod',
        'TELECEL': 'vod',
        'VOD': 'vod',
    };
    const detectedNetwork: 'mtn' | 'vod' | 'atl' | undefined = arkeselNetwork ? arkeselNetworkMap[arkeselNetwork] : undefined;

    console.log(`[USSD] Incoming request body: ${JSON.stringify(req.body)}`);
    const newSession = req.body.newSession;
    const type = req.body.type;

    // Detect if this is the start of a session
    const isInitialRequest = 
        newSession === true || 
        newSession === 'true' || 
        type === 'initiation' ||
        userData === null ||
        userData === '' || 
        (typeof userData === 'string' && userData.startsWith('*') && userData.endsWith('#'));

    const resolvedSessionId = sessionID ? String(sessionID) : undefined;
    const resolvedPhoneNumber = msisdn ? String(msisdn) : undefined;
    const resolvedText = isInitialRequest ? '' : (userData || '');

    const sessionId = resolvedSessionId;
    const phoneNumber = resolvedPhoneNumber;
    const text = resolvedText;

    if (!sessionId || !phoneNumber) {
        sendUSSD(res, 'END Invalid request. Please try again.');
        return;
    }

    // ── SERVICE CODE VALIDATION ───────────────────────────────────────────────
    // Only accept requests for the officially purchased USSD code *928*347#.
    // Reject any other service code immediately.
    const ALLOWED_SERVICE_CODE = config.ussd.serviceCode; // '*928*347#'
    const checkServiceCode = serviceCode || (isInitialRequest && typeof userData === 'string' && userData.startsWith('*') && userData.endsWith('#') ? userData : undefined);
    if (checkServiceCode) {
        const cleanAllowed = ALLOWED_SERVICE_CODE.endsWith('#') ? ALLOWED_SERVICE_CODE.slice(0, -1) : ALLOWED_SERVICE_CODE;
        const cleanChecked = checkServiceCode.endsWith('#') ? checkServiceCode.slice(0, -1) : checkServiceCode;
        if (cleanChecked !== cleanAllowed) {
            console.warn(`[USSD] Rejected request for unknown serviceCode: ${checkServiceCode}`);
            sendUSSD(res, 'END This service is not available on this code.');
            return;
        }
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
        if (text === '' || text === undefined || text === null) {
            session.step = 'awaiting_student_id';
            sessions.set(sessionId, session);

            sendUSSD(res, 'CON Welcome to PentVars Pay\nEnter your Student ID:');
            return;
        }

        // ── STUDENT ID ENTRY ───────────────────────────────────────────────
        if (session.step === 'awaiting_student_id') {
            const studentIdInput = lastInput.trim().toUpperCase();

            const student = await User.findOne({ 
                studentId: { $regex: new RegExp('^' + studentIdInput + '$', 'i') }, 
                role: 'student' 
            });
            if (!student) {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Student ID not found. Please check your ID and try again.');
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

            const menuLines = [
                `CON Welcome, ${student.firstName}!`,
                `ID: ${student.studentId}`,
                '',
                '1. Pay Academic Fee',
            ];

            if (student.hostelOption) {
                menuLines.push('2. Pay Hostel Fee');
            }

            menuLines.push(
                '3. Pay Resit Fee',
                '4. Pay Supplementary Fee',
                '5. Check Balance'
            );

            sendUSSD(res, menuLines.join('\n'));
            return;
        }

        // ── MAIN MENU OPTIONS ─────────────────────────────────────────────
        if (session.step === 'main_menu_options') {
            const student = await User.findById(session.studentDbId);
            if (!student) {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Session expired. Please try again.');
                return;
            }

            switch (lastInput) {
                case '1': // Academic Fee
                    session.feeType = 'academic';
                    session.step = 'confirm_academic';
                    sessions.set(sessionId, session);
                    await sendAcademicFeeInfo(sessionId, session, student, res);
                    return;

                case '2': // Hostel Fee
                    if (!student.hostelOption) {
                        sendUSSD(res, 'END You are not eligible for hostel fee payment.');
                        return;
                    }
                    session.feeType = 'hostel';
                    session.step = 'select_hostel_fee';
                    sessions.set(sessionId, session);
                    await sendHostelFeeInfo(sessionId, session, student, res);
                    return;

                case '3': // Resit Fee
                    session.feeType = 'resit';
                    session.step = 'select_resit_fee';
                    sessions.set(sessionId, session);
                    await sendResitFeeInfo(sessionId, session, student, res);
                    return;

                case '4': // Supplementary Fee
                    session.feeType = 'supplementary';
                    session.step = 'select_supplementary_fee';
                    sessions.set(sessionId, session);
                    await sendSupplementaryFeeInfo(sessionId, session, student, res);
                    return;

                case '5': // Check Balance
                    session.step = 'check_balance';
                    sessions.set(sessionId, session);
                    await sendBalanceInfo(sessionId, session, student, res);
                    return;

                default:
                    sendUSSD(res, 'CON Invalid option. Please try again.\n\n1. Pay Academic Fee\n2. Pay Hostel Fee\n3. Pay Resit Fee\n4. Pay Supplementary Fee\n5. Check Balance');
                    return;
            }
        }

        // ── CONFIRM ACADEMIC FEE ──────────────────────────────────────────
        if (session.step === 'confirm_academic') {
            if (lastInput === '1') {
                session.step = 'enter_amount';
                sessions.set(sessionId, session);
                sendUSSD(res, `CON Enter amount to pay (Max: GHS ${session.amount?.toFixed(2)}):`);
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Payment cancelled.');
            } else {
                sendUSSD(res, 'CON Press 1 to confirm or 2 to cancel');
            }
            return;
        }

        // ── CONFIRM HOSTEL FEE ────────────────────────────────────────────
        if (session.step === 'confirm_hostel') {
            if (lastInput === '1') {
                session.step = 'enter_amount';
                sessions.set(sessionId, session);
                sendUSSD(res, `CON Enter amount to pay (Max: GHS ${session.amount?.toFixed(2)}):`);
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Payment cancelled.');
            } else {
                sendUSSD(res, 'CON Press 1 to confirm or 2 to cancel');
            }
            return;
        }

        // ── CONFIRM RESIT FEE ─────────────────────────────────────────────
        if (session.step === 'confirm_resit') {
            if (lastInput === '1') {
                session.step = 'enter_amount';
                sessions.set(sessionId, session);
                sendUSSD(res, `CON Enter amount to pay (Max: GHS ${session.amount?.toFixed(2)}):`);
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Payment cancelled.');
            } else {
                sendUSSD(res, 'CON Press 1 to confirm or 2 to cancel');
            }
            return;
        }

        // ── CONFIRM SUPPLEMENTARY FEE ─────────────────────────────────────
        if (session.step === 'confirm_supplementary') {
            if (lastInput === '1') {
                session.step = 'enter_amount';
                sessions.set(sessionId, session);
                sendUSSD(res, `CON Enter amount to pay (Max: GHS ${session.amount?.toFixed(2)}):`);
            } else if (lastInput === '2') {
                sessions.delete(sessionId);
                sendUSSD(res, 'END Payment cancelled.');
            } else {
                sendUSSD(res, 'CON Press 1 to confirm or 2 to cancel');
            }
            return;
        }

        // ── ENTER AMOUNT ──────────────────────────────────────────────────
        if (session.step === 'enter_amount') {
            const enteredAmount = parseFloat(lastInput.trim());
            const maxAmount = session.amount || 0;

            if (isNaN(enteredAmount) || enteredAmount <= 0) {
                sendUSSD(res, `CON Invalid amount. Enter a valid amount to pay (Max: GHS ${maxAmount.toFixed(2)}):`);
                return;
            }

            if (enteredAmount > maxAmount) {
                sendUSSD(res, `CON Amount exceeds outstanding balance of GHS ${maxAmount.toFixed(2)}.\nEnter amount to pay (Max: GHS ${maxAmount.toFixed(2)}):`);
                return;
            }

            session.amount = enteredAmount;
            session.step = 'select_network';
            sessions.set(sessionId, session);
            sendUSSD(res, 'CON Select payment method:\n1. MTN Mobile Money\n2. Vodafone/Telecel Cash\n3. AirtelTigo Money\n4. Card/Bank Transfer');
            return;
        }

        // ── NETWORK SELECTION & PAYMENT ────────────────────────────────────
        if (session.step === 'select_network') {
            const networkMap: Record<string, 'mtn' | 'vod' | 'atl'> = {
                '1': 'mtn',
                '2': 'vod',
                '3': 'atl', // AirtelTigo
            };

            // If Arkesel already told us the network, skip selection and charge directly
            if (detectedNetwork && !['1', '2', '3', '4'].includes(lastInput)) {
                session.mobileNetwork = detectedNetwork;
                session.step = 'processing';
                sessions.set(sessionId, session);
                const cleanPhone = phoneNumber.replace('+', '');
                console.log(`[USSD] Auto-detected network from Arkesel: ${detectedNetwork}, phone: ${cleanPhone}`);
                await processUSSDMoMoPayment(sessionId, session, cleanPhone, res);
                return;
            }

            if (!['1', '2', '3', '4'].includes(lastInput)) {
                sendUSSD(res, 'CON Invalid option.\n1. MTN Mobile Money\n2. Vodafone/Telecel Cash\n3. AirtelTigo Money\n4. Card/Bank Transfer');
                return;
            }

            if (lastInput === '4') {
                // Card/Bank Transfer — generate Paystack link
                session.step = 'processing';
                sessions.set(sessionId, session);
                await processUSSDPayment(sessionId, session, phoneNumber, res);
            } else {
                session.mobileNetwork = networkMap[lastInput];
                session.step = 'processing';
                sessions.set(sessionId, session);
                
                // Format dialed phone number for Paystack (e.g., remove leading '+' if present)
                const cleanPhone = phoneNumber.replace('+', '');
                await processUSSDMoMoPayment(sessionId, session, cleanPhone, res);
            }
            return;
        }

        // ── REDUNDANT STEP BYPASSED ───────────────────────────────────────
        // (Kept handler signature for safety / backwards compatibility)
        if (session.step === 'enter_phone') {
            const phone = lastInput.trim();
            const cleanPhone = phone.startsWith('+') ? phone.replace('+', '') : `233${phone.substring(1)}`;
            session.step = 'processing';
            sessions.set(sessionId, session);
            await processUSSDMoMoPayment(sessionId, session, cleanPhone, res);
            return;
        }

        // ── AWAITING OTP: step removed — no longer reachable ────────────────
        if (session.step === 'awaiting_otp') {
            const otpCode = lastInput.trim();
            if (!otpCode || otpCode.length < 4) {
                sendUSSD(res, 'CON Invalid OTP. Please enter the OTP sent to your phone:');
                return;
            }

            const pendingRef = session.pendingOtpReference!;
            sessions.delete(sessionId);

            try {
                const otpResult = await PaystackService.submitOTP(otpCode, pendingRef);
                console.log('[USSD] OTP submit result:', JSON.stringify(otpResult));

                const dataStatus = otpResult?.data?.status;

                if (dataStatus === 'success') {
                    // ── 1. Update DB, ledger, sockets ──────
                    const txn = await Transaction.findOne({ reference: pendingRef });
                    if (txn) {
                        await finalizePaymentSuccess(
                            txn,
                            new Date(),
                            otpResult.data?.id?.toString() || pendingRef,
                            session.amount || txn.amount || txn.amountExpected || 0,
                            'mobile_money',
                            'OTP Verified via USSD'
                        );
                    }

                    // ── 2. Resolve parameters from session or txn ──────
                    const studentDbId = session.studentDbId || txn?.studentId;
                    const studentFeeId = session.studentFeeId || txn?.studentFeeId;
                    const feeItemId = session.feeItemId || txn?.feeItemId;
                    const amountPaid = session.amount || txn?.amount || txn?.amountExpected || 0;

                    let studentName = session.studentId || 'Student';
                    let studentId = session.studentId || '';
                    let feeSummary = '';

                    try {
                        const student = await User.findById(studentDbId).select('firstName lastName studentId');
                        if (student) {
                            studentName = `${student.firstName} ${student.lastName}`;
                            studentId = String(student.studentId ?? '');
                        }

                        if (studentFeeId) {
                            const updatedFee = await StudentFee.findById(studentFeeId)
                                .select('balance amountPaid totalAmount status');
                            if (updatedFee) {
                                const newBalance = updatedFee.balance;
                                const isPaid = updatedFee.status === 'paid' || newBalance <= 0;
                                feeSummary = `Balance: GHS ${newBalance.toFixed(2)}${isPaid ? ' (FULLY PAID)' : ''}`;
                            }
                        } else if (feeItemId) {
                            const updatedItem = await FeeItem.findById(feeItemId)
                                .select('balance amountPaid totalAmount status');
                            if (updatedItem) {
                                const newBalance = updatedItem.balance;
                                const isPaid = updatedItem.status === 'paid' || newBalance <= 0;
                                feeSummary = `Balance: GHS ${newBalance.toFixed(2)}${isPaid ? ' (FULLY PAID)' : ''}`;
                            }
                        }
                    } catch (fetchErr) {
                        console.error('[USSD] Balance fetch error after OTP:', fetchErr);
                    }

                    // ── 3. Send rich success message ─────────────────────────
                    sendUSSD(res, [
                        `END PAYMENT SUCCESSFUL`,
                        `Name: ${studentName}`,
                        `ID: ${studentId}`,
                        `Paid: GHS ${amountPaid.toFixed(2)}`,
                        feeSummary,
                        `Ref: ${pendingRef}`,
                        `Thank you!`,
                    ].filter(Boolean).join('\n'));

                } else if (dataStatus === 'pay_offline' || dataStatus === 'pending') {
                    sendUSSD(res, [
                        `END OTP accepted!`,
                        `Approve the MoMo prompt on your phone to complete payment.`,
                        `Ref: ${pendingRef}`,
                        `You will receive an SMS confirmation once approved.`,
                    ].join('\n'));

                } else {
                    sendUSSD(res, `END OTP verification failed: ${otpResult?.message || 'Unknown error'}. Please dial *928*347# and try again.`);
                }
            } catch (err: any) {
                console.error('[USSD] OTP submit error:', err);
                sendUSSD(res, `END OTP error. Please dial *928*347# and try again.`);
            }
            return;
        }

        // ── AWAITING MOMO APPROVAL (Status polling/checking) ──────────────────
        if (session.step === 'awaiting_momo_approval') {
            const pendingRef = session.pendingOtpReference!;

            if (lastInput === '1') {
                try {
                    // Check local DB first in case webhook succeeded very fast
                    const txn = await Transaction.findOne({ reference: pendingRef });
                    let status = 'pending';

                    if (txn && txn.status === 'completed') {
                        status = 'success';
                    } else {
                        const verifyResult = await PaystackService.verifyTransaction(pendingRef);
                        console.log('[USSD] MoMo status check result:', JSON.stringify(verifyResult));
                        status = verifyResult?.data?.status || 'pending';

                        if (status === 'success' && txn) {
                            await finalizePaymentSuccess(
                                txn,
                                new Date(verifyResult.data?.paid_at || Date.now()),
                                verifyResult.data?.id?.toString() || pendingRef,
                                session.amount || txn.amount || txn.amountExpected || 0,
                                'mobile_money',
                                'MoMo Verified via USSD Menu'
                            );
                        }
                    }

                    if (status === 'success') {
                        // ── 2. Resolve parameters from session or txn ──────
                        const studentDbId = session.studentDbId || txn?.studentId;
                        const studentFeeId = session.studentFeeId || txn?.studentFeeId;
                        const feeItemId = session.feeItemId || txn?.feeItemId;
                        const amountPaid = session.amount || txn?.amount || txn?.amountExpected || 0;

                        let studentName = session.studentId || 'Student';
                        let studentId = session.studentId || '';
                        let feeSummary = '';

                        try {
                            const student = await User.findById(studentDbId).select('firstName lastName studentId');
                            if (student) {
                                studentName = `${student.firstName} ${student.lastName}`;
                                studentId = String(student.studentId ?? '');
                            }

                            if (studentFeeId) {
                                const updatedFee = await StudentFee.findById(studentFeeId)
                                    .select('balance amountPaid totalAmount status');
                                if (updatedFee) {
                                    const newBalance = updatedFee.balance;
                                    const isPaid = updatedFee.status === 'paid' || newBalance <= 0;
                                    feeSummary = `Balance: GHS ${newBalance.toFixed(2)}${isPaid ? ' (FULLY PAID)' : ''}`;
                                }
                            } else if (feeItemId) {
                                const updatedItem = await FeeItem.findById(feeItemId)
                                    .select('balance amountPaid totalAmount status');
                                if (updatedItem) {
                                    const newBalance = updatedItem.balance;
                                    const isPaid = updatedItem.status === 'paid' || newBalance <= 0;
                                    feeSummary = `Balance: GHS ${newBalance.toFixed(2)}${isPaid ? ' (FULLY PAID)' : ''}`;
                                }
                            }
                        } catch (fetchErr) {
                            console.error('[USSD] Balance fetch error after check:', fetchErr);
                        }

                        sessions.delete(sessionId);
                        sendUSSD(res, [
                            `END PAYMENT SUCCESSFUL`,
                            `Name: ${studentName}`,
                            `ID: ${studentId}`,
                            `Paid: GHS ${amountPaid.toFixed(2)}`,
                            feeSummary,
                            `Ref: ${pendingRef}`,
                            `Thank you!`,
                        ].filter(Boolean).join('\n'));
                        return;
                    } else if (status === 'failed') {
                        sessions.delete(sessionId);
                        sendUSSD(res, `END Payment failed or was declined. Reference: ${pendingRef}. Please dial *928*347# and try again.`);
                        return;
                    } else {
                        // Still pending
                        sendUSSD(res, [
                            `CON Payment is still pending approval.`,
                            `Please approve the MoMo prompt on your phone, then select:`,
                            `1. Confirm Payment Status`,
                            `2. Exit`,
                        ].join('\n'));
                        return;
                    }
                } catch (err: any) {
                    console.error('[USSD] Status check error:', err);
                    sendUSSD(res, `END Error checking payment status. Please dial *928*347# and try again.`);
                    return;
                }
            } else {
                // User chose 2 or other options to cancel/exit
                sessions.delete(sessionId);
                sendUSSD(res, `END Session closed. If you approved the MoMo prompt, your account will be updated automatically via webhook. Thank you!`);
                return;
            }
        }

        // ── BALANCE CHECK (already sent — just cleanup) ────────────────────
        if (session.step === 'check_balance') {
            sessions.delete(sessionId);
            sendUSSD(res, 'END Thank you for checking your balance.');
            return;
        }

        // Default — unrecognised state
        sessions.delete(sessionId);
        sendUSSD(res, 'END Session ended. Please dial again.');

    } catch (error: any) {
        console.error('[USSD] Error:', error);
        sessions.delete(sessionId);
        sendUSSD(res, 'END An error occurred. Please try again later.');
    }
};

// ─── Fee Info Helpers ─────────────────────────────────────────────────────────

async function sendAcademicFeeInfo(sessionId: string, session: USSDSession, student: any, res: Response): Promise<void> {
    try {
        // Get or create student fee (semester 1 first, then 2)
        let studentFee = null;
        try { studentFee = await FeeCalculationService.getOrCreateStudentFee(student, 1); } catch { }
        if (!studentFee || studentFee.status === 'paid') {
            try { studentFee = await FeeCalculationService.getOrCreateStudentFee(student, 2); } catch { }
        }

        if (!studentFee || studentFee.status === 'paid') {
            sessions.delete(sessionId);
            sendUSSD(res, 'END Your academic fees are fully paid. Thank you!');
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

        sendUSSD(res, msg);
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error: ${error.message}`);
    }
}

async function sendHostelFeeInfo(sessionId: string, session: USSDSession, student: any, res: Response): Promise<void> {
    try {
        // Find hostel FeeTypes, then query FeeItems that reference them
        const hostelFeeTypes = await FeeType.find({ category: 'hostel', isActive: true });
        const hostelFeeTypeIds = hostelFeeTypes.map(ft => ft._id);

        const hostelFees = await FeeItem.find({
            studentId: student.id,
            feeTypeId: { $in: hostelFeeTypeIds },
            status: { $in: ['pending', 'partial'] },
        }).populate('feeTypeId');

        if (hostelFees.length === 0) {
            sessions.delete(sessionId);
            sendUSSD(res, 'END No hostel fee record found. Contact administration.');
            return;
        }

        const fee = hostelFees[0];
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

        sendUSSD(res, msg);
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error: ${error.message}`);
    }
}

async function sendResitFeeInfo(sessionId: string, session: USSDSession, student: any, res: Response): Promise<void> {
    try {
        const resitFeeTypes = await FeeType.find({ category: 'resit', isActive: true });
        const resitFeeTypeIds = resitFeeTypes.map(ft => ft._id);

        const fees = await FeeItem.find({
            studentId: student.id,
            feeTypeId: { $in: resitFeeTypeIds },
            status: { $in: ['pending', 'partial'] },
        }).populate('feeTypeId');

        if (fees.length === 0) {
            sessions.delete(sessionId);
            sendUSSD(res, 'END No resit fee record found. Contact examination office.');
            return;
        }

        const fee = fees[0];
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

        sendUSSD(res, msg);
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error: ${error.message}`);
    }
}

async function sendSupplementaryFeeInfo(sessionId: string, session: USSDSession, student: any, res: Response): Promise<void> {
    try {
        const suppFeeTypes = await FeeType.find({ category: 'supplementary', isActive: true });
        const suppFeeTypeIds = suppFeeTypes.map(ft => ft._id);

        const fees = await FeeItem.find({
            studentId: student.id,
            feeTypeId: { $in: suppFeeTypeIds },
            status: { $in: ['pending', 'partial'] },
        }).populate('feeTypeId');

        if (fees.length === 0) {
            sessions.delete(sessionId);
            sendUSSD(res, 'END No supplementary fee record found. Contact examination office.');
            return;
        }

        const fee = fees[0];
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

        sendUSSD(res, msg);
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error: ${error.message}`);
    }
}

async function sendBalanceInfo(sessionId: string, session: USSDSession, student: any, res: Response): Promise<void> {
    try {
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

        sessions.delete(sessionId);
        sendUSSD(res, lines.join('\n'));
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error fetching balance: ${error.message}`);
    }
}

// ─── Payment Processing ───────────────────────────────────────────────────────

/**
 * Demo mode: Simulate a successful payment without calling Paystack.
 * Records the transaction in the DB so everything looks real during a presentation.
 */
async function processDemoPayment(
    sessionId: string,
    session: USSDSession,
    student: any,
    paymentMethod: 'mobile_money' | 'bank_transfer',
    phoneOrNetwork: string,
    res: Response
): Promise<void> {
    if (!session.amount) {
        sessions.delete(sessionId);
        sendUSSD(res, 'END Session error. Please try again.');
        return;
    }

    const reference = generateReference('DEMO');
    const category = session.feeType as any || 'academic';
    const description = `[DEMO] USSD ${category} fee payment`;

    try {
        // Create a transaction marked as pending first, then finalize it.
        const transaction = await Transaction.create({
            studentId: student.id,
            feeItemId: session.feeItemId || undefined,
            studentFeeId: session.studentFeeId || undefined,
            amount: session.amount,
            amountExpected: session.amount,
            paymentMethod,
            paymentChannel: 'ussd',
            status: 'pending',
            reference,
            category,
            description,
            webhookVerified: false,
            metadata: { channel: 'ussd', demoMode: true, network: phoneOrNetwork },
        });

        // Finalize transaction using the shared payment controller function.
        await finalizePaymentSuccess(
            transaction,
            new Date(),
            reference,
            session.amount,
            paymentMethod === 'mobile_money' ? 'mobile_money' : 'bank_transfer',
            'Approved (Demo USSD)'
        );

        sessions.delete(sessionId);

        sendUSSD(res, [
            `END Payment Successful! (Demo)`,
            `Amount: GHS ${session.amount?.toFixed(2)}`,
            `Ref: ${reference}`,
            `Fee: ${category}`,
            `Thank you, ${student.firstName}!`,
        ].join('\n'));
    } catch (error: any) {
        console.error('[USSD] Demo payment error:', error);
        sessions.delete(sessionId);
        sendUSSD(res, `END Demo error: ${error.message}`);
    }
}

async function processUSSDMoMoPayment(sessionId: string, session: USSDSession, intlPhone: string, res: Response): Promise<void> {
    const student = await User.findById(session.studentDbId);
    if (!student || !session.amount) {
        sessions.delete(sessionId);
        sendUSSD(res, 'END Session error. Please try again.');
        return;
    }

    console.log(`[USSD] processUSSDMoMoPayment → phone: ${intlPhone} | network: ${session.mobileNetwork} | amount: ${session.amount} | demoMode: ${config.ussd.demoMode}`);

    // ── DEMO MODE: Simulate payment without calling Paystack ──
    if (config.ussd.demoMode) {
        console.log('[USSD] Running in DEMO mode — no real charge sent');
        await processDemoPayment(sessionId, session, student, 'mobile_money', session.mobileNetwork || 'mtn', res);
        return;
    }

    console.log(`[USSD] LIVE mode — preparing charge for ${intlPhone} via Paystack`);
    const reference = generateReference('USSD');
    const category = session.feeType as any || 'academic';
    const description = `USSD ${category} fee payment`;

    try {
        // Create pending transaction BEFORE closing session (no race condition on reference)
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

        // Format to local 10-digit phone number for Paystack GHS Mobile Money API (e.g. 055...)
        const localPhone = intlPhone.startsWith('233')
            ? '0' + intlPhone.substring(3)
            : (intlPhone.startsWith('0') ? intlPhone : '0' + intlPhone);

        const networkLabel = session.mobileNetwork === 'mtn' ? 'MTN' : session.mobileNetwork === 'vod' ? 'Telecel' : 'AirtelTigo';
        console.log(`[USSD] Transaction created: ${reference} | localPhone: ${localPhone} | network: ${networkLabel}`);

        // ── CRITICAL FIX: Close the USSD session FIRST before charging ──
        // While the student's phone is inside an active USSD session (*928*347#),
        // MTN/Telecel CANNOT deliver a second USSD push prompt (MoMo PIN screen).
        // End the session now so the phone is free to receive the MoMo push.
        sessions.delete(sessionId);
        sendUSSD(res, [
            `END GHS ${session.amount.toFixed(2)} payment initiated.`,
            `A ${networkLabel} MoMo prompt will appear shortly.`,
            `Enter your MoMo PIN to confirm.`,
            `No prompt? Dial *170# > My Wallet > Approvals.`,
        ].join('\n'));

        // ── Fire Paystack charge AFTER 5-second delay ──
        // The END response is sent to Arkesel → MTN closes the USSD session on the phone.
        // We wait 5 seconds so MTN fully processes the session closure before we
        // ask them to open a NEW USSD push channel for the MoMo PIN prompt.
        // (setImmediate fired < 1ms after response — MTN hadn't cleared the session yet)
        const chargeDelayMs = 1500; // 1.5s — enough for MTN to close USSD before MoMo push arrives
        console.log(`[USSD] Waiting ${chargeDelayMs}ms for MTN to clear USSD session before charging...`);

        setTimeout(async () => {
            try {
                // Minimum amount guard — Paystack rejects amounts below GHS 0.50
                const MIN_AMOUNT_GHS = 0.50;
                if ((session.amount ?? 0) < MIN_AMOUNT_GHS) {
                    console.error(`[USSD] Amount GHS ${session.amount} is below Paystack minimum of GHS ${MIN_AMOUNT_GHS}. Aborting charge. ref: ${reference}`);
                    await Transaction.findByIdAndUpdate(transaction.id, {
                        status: 'failed',
                        description: `Amount GHS ${session.amount} too small (minimum GHS ${MIN_AMOUNT_GHS})`,
                    }).catch(console.error);
                    return;
                }

                console.log(`[USSD] Sending charge to Paystack: phone=${localPhone} network=${session.mobileNetwork} amount=${session.amount} ref=${reference}`);
                const chargeResult = await PaystackService.chargeMobileMoney(
                    session.amount!,
                    student.email,
                    reference,
                    localPhone,
                    session.mobileNetwork || 'mtn',
                    { studentId: student.studentId, category, description, transactionId: transaction.id }
                );

                console.log('[USSD] Paystack charge result:', JSON.stringify(chargeResult));
                const chargeDataStatus = chargeResult?.data?.status;
                console.log(`[USSD] Charge status: ${chargeDataStatus} | phone: ${localPhone} | network: ${session.mobileNetwork} | ref: ${reference}`);

                if (!chargeResult?.status) {
                    console.error(`[USSD] Charge failed for ref ${reference}: ${chargeResult?.message}`);
                    await Transaction.findByIdAndUpdate(transaction.id, {
                        status: 'failed',
                        description: chargeResult?.message || 'Paystack charge failed',
                    }).catch(console.error);
                    return;
                }

                await AuditLog.create({
                    action: 'ussd_payment_initiated',
                    reference,
                    studentId: student.id,
                    amount: session.amount,
                    category,
                    channel: 'ussd-momo',
                    details: { network: session.mobileNetwork, chargeStatus: chargeDataStatus, localPhone },
                    isError: false,
                }).catch(console.error);

                console.log(`[USSD] ✅ MoMo push sent. Customer should now see PIN prompt. status=${chargeDataStatus} ref=${reference}`);
            } catch (asyncError: any) {
                console.error(`[USSD] Async charge error for ref ${reference}:`, asyncError.message);
                await Transaction.findByIdAndUpdate(transaction.id, {
                    status: 'failed',
                    description: asyncError.message,
                }).catch(console.error);
            }
        }, chargeDelayMs);

    } catch (error: any) {
        console.error('[USSD] MoMo payment setup error:', error);
        sessions.delete(sessionId);
        sendUSSD(res, `END Payment error: ${error.message}. Please try again.`);
    }
}

async function processUSSDPayment(sessionId: string, session: USSDSession, phoneNumber: string, res: Response): Promise<void> {
    const student = await User.findById(session.studentDbId);
    if (!student || !session.amount) {
        sessions.delete(sessionId);
        sendUSSD(res, 'END Session error. Please try again.');
        return;
    }

    // ── DEMO MODE: Simulate payment without calling Paystack ──
    if (config.ussd.demoMode) {
        await processDemoPayment(sessionId, session, student, 'bank_transfer', 'card', res);
        return;
    }

    // ── LIVE MODE: Real Paystack initialization ──
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

        sessions.delete(sessionId);

        sendUSSD(res,
            `END Payment link generated.\nRef: ${reference}\nAmount: GHS ${session.amount.toFixed(2)}\nVisit: ${psResponse.data?.authorization_url || 'Check SMS'}`
        );
    } catch (error: any) {
        sessions.delete(sessionId);
        sendUSSD(res, `END Error: ${error.message}`);
    }
}

/**
 * GET /api/ussd/menu
 * Returns the USSD menu structure (for testing/documentation)
 */
export const getUSSDMenu = async (req: Request, res: Response): Promise<void> => {
    res.json({
        serviceCode: config.ussd.serviceCode,
        demoMode: config.ussd.demoMode,
        demoModeNote: config.ussd.demoMode
            ? '⚠️ DEMO MODE is ON — payments are simulated, no real charges are made.'
            : '💳 LIVE MODE — payments go through Paystack.',
        menu: {
            main: ['1. Pay Academic Fee', '2. Pay Hostel Fee', '3. Pay Resit Fee', '4. Pay Supplementary Fee', '5. Check Balance'],
            paymentMethods: ['1. MTN Mobile Money', '2. Vodafone/Telecel Cash', '3. AirtelTigo Money', '4. Card/Bank Transfer'],
        },
        description: 'PentVars Pay USSD Service for Pentecost University students',
        howToTest: {
            endpoint: 'POST /api/ussd/session',
            contentType: 'application/json',
            sampleBody: {
                sessionId: 'test-session-001',
                serviceCode: config.ussd.serviceCode,
                phoneNumber: '+233241234567',
                text: '',
            },
            note: 'Send text="" for main menu. Then send accumulated inputs separated by * (e.g. "PU0001" then "PU0001*1" then "PU0001*1*1", etc.)',
        },
    });
};
