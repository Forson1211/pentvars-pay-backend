import { Request, Response, NextFunction } from 'express';
import { Transaction, FeeCategory } from '../models/Transaction';
import { FeeItem } from '../models/FeeItem';
import { FeeType } from '../models/FeeType';
import { StudentFee } from '../models/StudentFee';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { Payment } from '../models/Payment';
import { AuditLog } from '../models/AuditLog';
import { generateReference } from '../utils/helpers';
import { FeeCalculationService } from '../services/feeCalculationService';
import { PaystackService } from '../services/paystackService';
import { emitPaymentUpdate, emitPaymentCancelled, emitFeeUpdate } from '../services/socketService';
import { config } from '../config/env';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Determine the fee category from a feeType or studentFee
 */
function resolveFeeCategory(feeType: any, isAcademic: boolean): FeeCategory {
    if (isAcademic) return 'academic';
    const cat = (feeType?.category || '').toLowerCase();
    if (cat === 'hostel') return 'hostel';
    if (cat === 'resit') return 'resit';
    if (cat === 'supplementary') return 'supplementary';
    if (cat === 'exam') return 'exam';
    return 'other';
}

/**
 * Update ledger after verified payment
 * Applies: academic -> StudentFee, optional -> FeeItem
 */
async function updateLedger(
    feeItem: any,
    academicFee: any,
    amount: number,
    category: FeeCategory
): Promise<void> {
    if (category === 'academic' && academicFee) {
        await FeeCalculationService.processPayment(academicFee._id, amount);
    } else if (feeItem) {
        feeItem.amountPaid += amount;
        feeItem.balance = Math.max(0, feeItem.totalAmount - feeItem.amountPaid);
        feeItem.status = feeItem.balance === 0 ? 'paid' : 'partial';
        await feeItem.save();
    }
}

/**
 * Finalize a successful transaction: mark completed, save payment, update ledger, audit, and notify.
 * Guaranteed to be called exactly once per successful payment from both webhook and redirect verify paths.
 */
export async function finalizePaymentSuccess(
    transaction: any,
    paidAtDate: Date,
    providerRef: string,
    amountGHSPaid: number,
    channel: string,
    gatewayResponse: string
): Promise<void> {
    // ── 1. Duplicate check (idempotency) ──
    if (transaction.status === 'completed' && transaction.webhookVerified) {
        console.log(`[finalizePaymentSuccess] Duplicate processing blocked for ${transaction.reference}`);
        return;
    }

    // ── 2. Mark transaction as successful ──
    transaction.status = 'completed';
    transaction.webhookVerified = true;
    transaction.paidAt = paidAtDate;
    transaction.providerReference = providerRef;
    transaction.amount = amountGHSPaid;
    transaction.metadata = {
        ...transaction.metadata,
        channel,
        gatewayResponse,
        paystackId: providerRef,
    };
    await transaction.save();

    // ── 3. Create/Update Payment record ──
    await Payment.findOneAndUpdate(
        { transactionReference: transaction.reference },
        {
            student: transaction.studentId,
            amount: amountGHSPaid,
            paymentMethod: channel === 'mobile_money' ? 'mobile_money' :
                channel === 'card' ? 'card' : 'bank_transfer',
            transactionReference: transaction.reference,
            status: 'completed',
            paymentDate: paidAtDate,
            description: transaction.description,
            studentFee: transaction.studentFeeId,
            feeItem: transaction.feeItemId,
            metadata: { channel, gatewayResponse },
        },
        { upsert: true, new: true }
    ).catch(console.error);

    // ── 4. Update Ledger ──
    try {
        let feeItem: any = null;
        let academicFee: any = null;

        if (transaction.feeItemId) {
            feeItem = await FeeItem.findById(transaction.feeItemId);
        }
        if (transaction.studentFeeId) {
            academicFee = await StudentFee.findById(transaction.studentFeeId);
        }

        await updateLedger(feeItem, academicFee, amountGHSPaid, transaction.category);
    } catch (ledgerError: any) {
        console.error(`[finalizePaymentSuccess] Ledger update failed for ${transaction.reference}:`, ledgerError);
        await AuditLog.create({
            action: 'payment_failed',
            reference: transaction.reference,
            studentId: transaction.studentId,
            details: { error: 'Ledger update failed: ' + ledgerError.message },
            isError: true,
        }).catch(console.error);
    }

    // ── 5. Audit success ──
    await AuditLog.create({
        action: 'payment_success',
        reference: transaction.reference,
        studentId: transaction.studentId,
        amount: amountGHSPaid,
        category: transaction.category,
        channel,
        details: { paystackId: providerRef, gatewayResponse },
        isError: false,
    }).catch(console.error);

    // ── 6. Notify admins & emit socket update ──
    try {
        const student = await User.findById(transaction.studentId).select('firstName lastName');
        
        // Emit fee:updated to the student so their dashboard refreshes in real-time
        emitFeeUpdate({
            type: 'student_fee',
            action: 'updated',
            studentId: transaction.studentId.toString(),
            data: { 
                reference: transaction.reference, 
                amount: amountGHSPaid, 
                status: 'completed',
                transactionId: transaction._id.toString()
            }
        });

        // Create notification for the student
        if (student) {
            await Notification.create({
                recipientId: transaction.studentId,
                title: 'Payment Confirmed',
                body: `Your payment of GHS ${amountGHSPaid.toFixed(2)} for ${transaction.description} was processed successfully. Reference: ${transaction.reference}`,
                type: 'success',
                data: { transactionId: transaction._id },
            }).catch(console.error);
        }

        const admins = await User.find({ role: 'admin' }).select('_id');
        if (admins.length > 0 && student) {
            const adminNotifications = admins.map(admin => ({
                recipientId: admin._id,
                title: 'Payment Confirmed',
                body: `${student.firstName} ${student.lastName} paid GHS ${amountGHSPaid.toFixed(2)} — ${transaction.description}`,
                type: 'success',
                data: { transactionId: transaction._id, studentId: transaction.studentId },
            }));
            await Notification.insertMany(adminNotifications);
            
            // REAL-TIME SOCKET UPDATE
            emitPaymentUpdate({
                transactionId: transaction._id.toString(),
                studentId: transaction.studentId.toString(),
                studentName: `${student.firstName} ${student.lastName}`,
                amount: amountGHSPaid,
                description: transaction.description,
                reference: transaction.reference,
                category: transaction.category
            });
        }
    } catch (notifyError) {
        console.error('[finalizePaymentSuccess] Admin notification error:', notifyError);
    }
}

// ─── INITIATE PAYMENT ────────────────────────────────────────────────────────

/**
 * POST /api/payments/initiate
 * 
 * Student initiates a payment. Backend:
 * 1. Validates student identity
 * 2. Fetches official fee amounts from DB (NEVER from frontend)
 * 3. Checks hostel eligibility
 * 4. Generates unique reference
 * 5. Creates pending transaction record
 * 6. Initializes Paystack payment
 * 7. Returns authorization details to frontend
 *
 * Frontend MUST NOT send amount. Amount is always server-calculated.
 */
export const initiatePayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { feeItemId, studentFeeId, paymentMethod, phoneNumber, idempotencyKey } = req.body;
        const student = req.user!;

        const fs = require('fs');
        const logEntry = `[${new Date().toISOString()}] INCOMING REQUEST: FeeItem=${feeItemId}, StudentFee=${studentFeeId}, Method=${paymentMethod}, Amount=${req.body.amount}, Student=${student.id}\n`;
        fs.appendFileSync('pay_errors.log', logEntry);

        // ── Idempotency: prevent double-tap submissions ─────────────────────
        if (idempotencyKey) {
            const existing = await Transaction.findOne({ idempotencyKey, studentId: student.id });
            // Only return the cached result if it actually has a valid Paystack session URL
            if (existing && existing.paystackAuthorizationUrl) {
                res.status(201).json({
                    message: 'Payment already initiated',
                    transaction: existing.toJSON(),
                    paystackAccessCode: existing.paystackAccessCode,
                    paystackAuthorizationUrl: existing.paystackAuthorizationUrl,
                    amount: existing.amount,
                    reference: existing.reference,
                });
                return;
            }
        }

        let feeItem: any = null;
        let feeType: any = null;
        let academicFee: any = null;
        let officialAmount = 0;
        let description = 'Fee Payment';
        let category: FeeCategory = 'academic';

        // ── Resolve fee source ────────────────────────────────────────────────
        if (feeItemId) {
            // Optional fee (hostel, resit, supplementary, exam, etc.)
            feeItem = await FeeItem.findById(feeItemId).populate('feeTypeId');
            if (!feeItem) {
                res.status(404).json({ message: 'Fee item not found.' });
                return;
            }

            // Ensure this fee belongs to this student
            if (feeItem.studentId.toString() !== student.id.toString()) {
                res.status(403).json({ message: 'Unauthorized access to this fee record.' });
                return;
            }

            feeType = feeItem.feeTypeId;
            category = resolveFeeCategory(feeType, false);

            // Official amount is always the outstanding balance from DB
            officialAmount = feeItem.balance;
            description = `${feeType?.name || 'Fee'} Payment`;

            if (feeItem.status === 'paid') {
                res.status(400).json({ message: 'This fee has already been paid.' });
                return;
            }

        } else if (studentFeeId) {
            // Academic fee (tuition from template)
            academicFee = await StudentFee.findById(studentFeeId).populate('academicYear feeTemplate');
            if (!academicFee) {
                res.status(404).json({ message: 'Academic fee record not found.' });
                return;
            }

            // Ensure this fee belongs to this student
            if (academicFee.student.toString() !== student.id.toString()) {
                res.status(403).json({ message: 'Unauthorized access to this fee record.' });
                return;
            }

            if (academicFee.status === 'paid') {
                res.status(400).json({ message: 'This academic fee has already been paid.' });
                return;
            }

            category = 'academic';
            officialAmount = academicFee.balance;
            description = `Academic Fee Payment - ${(academicFee.academicYear as any)?.yearLabel || ''} S${academicFee.semester}`;
        } else {
            res.status(400).json({ message: 'Either feeItemId or studentFeeId is required.' });
            return;
        }

        if (officialAmount <= 0) {
            res.status(400).json({ message: 'Outstanding balance is zero. No payment required.' });
            return;
        }

        // ── Support Partial Payments ────────────────────────────────────────
        let finalAmount = officialAmount;
        if (req.body.amount) {
            const userAmount = parseFloat(req.body.amount);
            if (!isNaN(userAmount) && userAmount > 0) {
                if (userAmount > officialAmount) {
                    res.status(400).json({ message: 'Payment amount exceeds outstanding balance.' });
                    return;
                }
                finalAmount = userAmount;
            }
        }

        // ── Generate unique reference ──────────────────────────────────────
        const reference = generateReference('PVP');

        // ── Create PENDING transaction (before Paystack call) ─────────────
        const transaction = await Transaction.create({
            studentId: student.id,
            feeItemId: feeItem?._id,
            studentFeeId: academicFee?._id,
            amount: finalAmount,
            amountExpected: finalAmount,
            paymentMethod: paymentMethod || 'mobile_money',
            paymentChannel: 'paystack',
            status: 'pending',
            reference,
            category,
            description,
            phoneNumber,
            webhookVerified: false,
            idempotencyKey: idempotencyKey || undefined,
            metadata: {
                studentId: student.studentId,
                feeCategory: category,
                initiatedAt: new Date().toISOString(),
            },
        });

        // ── Audit log ─────────────────────────────────────────────────────
        await AuditLog.create({
            action: 'payment_initiated',
            reference,
            studentId: student.id,
            amount: finalAmount,
            category,
            channel: paymentMethod,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            details: { feeItemId, studentFeeId, originalBalance: officialAmount },
            isError: false,
        });

        // ── Initialize Paystack ──────────────────────────────────────────
        let paystackResult: any = null;
        let paystackError: string | null = null;

        const host = req.get('host') || 'localhost:5000';
        const isLocal = host.includes('localhost') || host.includes('127.0.0.1') || host.includes('172.') || host.includes('192.168.');
        const protocol = isLocal ? 'http' : 'https';
        const callbackUrl = `${protocol}://${host}/api/payments/callback/${reference}`;
        const cancelUrl = `${protocol}://${host}/api/payments/cancel/${reference}`;

        try {
            const paystackResponse = await PaystackService.initializeTransaction(
                finalAmount,
                student.email,
                reference,
                {
                    studentId: student.studentId,
                    studentName: `${student.firstName} ${student.lastName}`,
                    category,
                    description,
                    feeItemId: feeItem?._id?.toString(),
                    studentFeeId: academicFee?._id?.toString(),
                    cancel_action: cancelUrl,
                },
                determineSupportedChannels(paymentMethod, category),
                callbackUrl
            );

            if (paystackResponse.status && paystackResponse.data) {
                paystackResult = paystackResponse.data;
                // Save Paystack details to transaction
                await Transaction.findByIdAndUpdate(transaction._id, {
                    paystackAccessCode: paystackResult.access_code,
                    paystackAuthorizationUrl: paystackResult.authorization_url,
                    status: 'processing',
                });
            } else {
                paystackError = paystackResponse.message || 'Paystack initialization failed';
                console.error(`Paystack Initialization Error [${officialAmount} GHS]:`, paystackError);
            }
        } catch (psError: any) {
            paystackError = psError.message;
            console.error(`Paystack Catch Error [${officialAmount} GHS]:`, paystackError);
            await AuditLog.create({
                action: 'payment_failed',
                reference,
                studentId: student.id,
                amount: officialAmount,
                category,
                details: { error: paystackError },
                isError: true,
            });
        }

        if (paystackError) {
            res.status(400).json({
                message: `Payment setup failed: ${paystackError}`,
                error: paystackError,
                reference
            });
            return;
        }

        res.status(201).json({
            message: 'Payment initialized successfully. Complete payment via Paystack.',
            transaction: {
                ...transaction.toJSON(),
                paystackAccessCode: paystackResult?.access_code,
                paystackAuthorizationUrl: paystackResult?.authorization_url,
                status: 'processing',
            },
            paystackAccessCode: paystackResult?.access_code || null,
            paystackAuthorizationUrl: paystackResult?.authorization_url || null,
            amount: finalAmount,
            reference,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Determine which Paystack channels to enable based on payment method and category
 */
function determineSupportedChannels(paymentMethod: string, category: FeeCategory): string[] {
    if (paymentMethod === 'mobile_money') return ['mobile_money'];
    if (paymentMethod === 'card') return ['card'];
    if (paymentMethod === 'bank_transfer') return ['bank_transfer', 'bank'];

    // Default fallback
    return ['card', 'mobile_money', 'bank_transfer', 'ussd'];
}

// ─── WEBHOOK HANDLER ─────────────────────────────────────────────────────────

/**
 * POST /api/payments/webhook
 * 
 * Paystack sends this when a payment is completed.
 * CRITICAL: This verifies the signature, confirms amount match, 
 * marks transaction as successful, and updates the ledger.
 * 
 * SECURITY:
 * - Raw body must be used for signature verification (before JSON.parse)
 * - Amount from Paystack must match amountExpected in DB
 * - Reference must exist in DB and be in 'pending'/'processing' state
 * - Duplicate webhooks are silently ignored (idempotent)
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
    // ── 1. Verify Paystack signature ─────────────────────────────────────
    const signature = req.headers['x-paystack-signature'] as string;
    const rawBody = (req as any).rawBody as string;

    if (!signature || !rawBody) {
        res.status(400).json({ message: 'Missing signature or body' });
        return;
    }

    const isValid = PaystackService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
        // Log failed verification attempt
        await AuditLog.create({
            action: 'webhook_rejected',
            details: { reason: 'Invalid signature', signature: signature?.substring(0, 20) },
            ip: req.ip,
            isError: true,
        }).catch(console.error);

        res.status(400).json({ message: 'Invalid webhook signature' });
        return;
    }

    const event = req.body;

    // Only process charge.success events
    if (event.event !== 'charge.success') {
        res.status(200).json({ message: 'Event ignored' });
        return;
    }

    const data = event.data;
    const reference = data?.reference;
    const amountPesewasPaid = data?.amount; // Paystack sends in pesewas
    const amountGHSPaid = amountPesewasPaid / 100;
    const channel = data?.channel;
    const gatewayResponse = data?.gateway_response;

    await AuditLog.create({
        action: 'webhook_received',
        reference,
        amount: amountGHSPaid,
        channel,
        details: { event: event.event, status: data?.status, gatewayResponse },
        isError: false,
    }).catch(console.error);

    // ── 2. Find the transaction ──────────────────────────────────────────
    const transaction = await Transaction.findOne({ reference });

    if (!transaction) {
        console.error(`[Webhook] Reference ${reference} not found in DB`);
        res.status(200).json({ message: 'Reference not found' }); // 200 to prevent Paystack retries
        return;
    }

    // ── 3. Duplicate check (idempotency) ─────────────────────────────────
    if (transaction.status === 'completed' && transaction.webhookVerified) {
        console.log(`[Webhook] Duplicate webhook for reference ${reference}. Ignoring.`);
        await AuditLog.create({
            action: 'duplicate_blocked',
            reference,
            studentId: transaction.studentId,
            isError: false,
        }).catch(console.error);
        res.status(200).json({ message: 'Already processed' });
        return;
    }

    // ── 4. Amount verification ─────────────────────────────────────────────
    const tolerance = 0.01; // 1 pesewa tolerance for floating point
    if (Math.abs(amountGHSPaid - transaction.amountExpected) > tolerance) {
        console.error(`[Webhook] Amount mismatch for ${reference}: paid ${amountGHSPaid}, expected ${transaction.amountExpected}`);
        await AuditLog.create({
            action: 'amount_mismatch',
            reference,
            studentId: transaction.studentId,
            amount: amountGHSPaid,
            details: { amountExpected: transaction.amountExpected, amountPaid: amountGHSPaid },
            isError: true,
        }).catch(console.error);

        // Mark as failed — do NOT update ledger
        transaction.status = 'failed';
        transaction.metadata = { ...transaction.metadata, webhookError: 'amount_mismatch' };
        await transaction.save();

        res.status(200).json({ message: 'Amount mismatch logged' });
        return;
    }

    // ── 5. Finalize payment success and propagate ─────────────────────────
    await finalizePaymentSuccess(
        transaction,
        new Date(data?.paid_at || Date.now()),
        data?.id?.toString() || 'N/A',
        amountGHSPaid,
        channel,
        gatewayResponse
    );
    // Always return 200 to Paystack to prevent retries
    res.status(200).json({ message: 'OK' });
};

// ─── VERIFY PAYMENT (from mobile app after redirect) ─────────────────────────

/**
 * GET /api/payments/verify/:reference
 * 
 * Called by the mobile app after Paystack redirect to confirm status.
 * Also re-verifies with Paystack API directly.
 */
export const verifyPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { reference } = req.params;
        const refStr = Array.isArray(reference) ? reference[0] : reference;

        const transaction = await Transaction.findOne({ reference });
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }

        // If already completed by webhook, return success
        if (transaction.status === 'completed' && transaction.webhookVerified) {
            res.json({ ...transaction.toJSON(), verified: true });
            return;
        }

        // Otherwise, call Paystack to verify
        try {
            const psVerify = await PaystackService.verifyTransaction(refStr);
            if (psVerify.status && psVerify.data?.status === 'success') {
                const amountGHSPaid = psVerify.data.amount / 100;

                if (Math.abs(amountGHSPaid - transaction.amountExpected) <= 0.01) {
                    const channel = psVerify.data.channel || 'paystack';
                    const gatewayResponse = psVerify.data.gateway_response || 'Approved';
                    const paidAt = psVerify.data.paid_at ? new Date(psVerify.data.paid_at) : new Date();
                    const providerRef = psVerify.data.id?.toString() || 'N/A';

                    await finalizePaymentSuccess(transaction, paidAt, providerRef, amountGHSPaid, channel, gatewayResponse);
                }
            } else if (psVerify.status && psVerify.data?.status === 'failed') {
                // Paystack explicitly reports failure — mark as failed
                transaction.status = 'failed';
                transaction.metadata = {
                    ...transaction.metadata,
                    cancelReason: psVerify.data?.gateway_response || 'Payment failed'
                };
                await transaction.save();
            } else if (psVerify.status && psVerify.data?.status === 'abandoned') {
                // Student closed Paystack without paying — keep as pending (they can retry)
                transaction.status = 'pending';
                transaction.metadata = {
                    ...transaction.metadata,
                    abandonedAt: new Date().toISOString()
                };
                await transaction.save();
            }
        } catch (psError) {
            // Paystack verify failed — return current DB status
            console.error('[VerifyPayment] Paystack verification error:', psError);
        }

        res.json({ ...transaction.toJSON(), verified: transaction.webhookVerified });
    } catch (error) {
        next(error);
    }
};

// ─── CANCEL PAYMENT ──────────────────────────────────────────────────────────

/**
 * PATCH /api/payments/:reference/cancel
 *
 * Student explicitly cancels a pending/processing payment.
 * Marks the transaction as 'cancelled' so it shows correctly in history.
 */
export const cancelPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { reference } = req.params;
        const refStr = (Array.isArray(reference) ? reference[0] : reference) as string;
        const student = req.user!;

        const transaction = await Transaction.findOne({ reference: refStr });
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }

        // Only the owning student may cancel
        if (transaction.studentId.toString() !== student.id.toString()) {
            res.status(403).json({ message: 'Unauthorized.' });
            return;
        }

        // Check actual status on Paystack before cancelling
        try {
            const psVerify = await PaystackService.verifyTransaction(refStr);
            if (psVerify.status && psVerify.data?.status === 'success') {
                // The payment has actually been completed! Finalize it instead of cancelling!
                const amountGHSPaid = psVerify.data.amount / 100;
                const channel = psVerify.data.channel || 'paystack';
                const gatewayResponse = psVerify.data.gateway_response || 'Approved';
                const paidAt = psVerify.data.paid_at ? new Date(psVerify.data.paid_at) : new Date();
                const providerRef = psVerify.data.id?.toString() || 'N/A';

                await finalizePaymentSuccess(transaction, paidAt, providerRef, amountGHSPaid, channel, gatewayResponse);
                
                res.status(400).json({ 
                    message: 'Cannot cancel this payment because it has already been completed successfully on Paystack.',
                    status: 'completed',
                    transaction: transaction.toJSON()
                });
                return;
            }
        } catch (psError) {
            console.error('[cancelPayment] Paystack status check failed:', psError);
        }

        transaction.status = 'cancelled';
        transaction.metadata = {
            ...transaction.metadata,
            cancelledAt: new Date().toISOString(),
            cancelledBy: 'student',
        };
        await transaction.save();

        // Emit fee:updated to student so their dashboard updates
        emitFeeUpdate({
            type: 'student_fee',
            action: 'updated',
            studentId: transaction.studentId.toString(),
            data: { reference, status: 'cancelled' }
        });

        await AuditLog.create({
            action: 'payment_cancelled',
            reference,
            studentId: student.id,
            amount: transaction.amount,
            category: transaction.category,
            isError: false,
        }).catch(console.error);

        // ── Real-time: Notify admins of cancellation ──────────────────────
        try {
            const studentUser = await User.findById(student.id).select('firstName lastName');
            if (studentUser) {
                emitPaymentCancelled({
                    transactionId: transaction._id.toString(),
                    studentId: transaction.studentId.toString(),
                    studentName: `${studentUser.firstName} ${studentUser.lastName}`,
                    amount: transaction.amount,
                    description: transaction.description,
                    reference: transaction.reference,
                    category: transaction.category,
                });
            }
        } catch (notifyErr) {
            console.error('[CancelPayment] Socket emit failed:', notifyErr);
        }

        res.json({ message: 'Payment cancelled successfully.', status: 'cancelled' });
    } catch (error) {
        next(error);
    }
};

// ─── GET TRANSACTION HISTORY ─────────────────────────────────────────────────

/**
 * GET /api/payments/history
 * Get transaction history for the authenticated student
 */
export const getTransactionHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const skip = (page - 1) * limit;

        const filter: Record<string, any> = {
            studentId: req.user!.id,
            hiddenByStudent: { $ne: true }, // hide records student has cleared
        };
        if (req.query.category) filter.category = req.query.category;
        if (req.query.status) filter.status = req.query.status;

        const [transactions, total] = await Promise.all([
            Transaction.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            Transaction.countDocuments(filter),
        ]);

        res.json({
            transactions: transactions.map((t) => t.toJSON()),
            total,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/payments/history/clear
 * Clears a student's transaction display history.
 *
 * IMPORTANT: We do NOT delete Payment records (they are the source of truth for
 * StudentFee.amountPaid and FeeItem.amountPaid balances). Only Transaction log
 * entries are removed. After deletion, we recalculate fee balances from the
 * remaining Payment data so everything stays accurate.
 */
export const clearTransactionHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const studentId = req.user!.id;

        // ── Soft-delete: mark as hidden instead of permanently deleting ──────────────
        // This preserves financial audit trail and admin visibility while clearing
        // the student's own history view. Payment records (fee balances) are untouched.
        const updateResult = await Transaction.updateMany(
            {
                studentId,
                status: { $in: ['completed', 'failed', 'pending', 'processing', 'cancelled'] },
                hiddenByStudent: { $ne: true }, // don't double-update
            },
            { $set: { hiddenByStudent: true } }
        );

        res.status(200).json({
            message: 'Transaction history cleared successfully.',
            hiddenCount: updateResult.modifiedCount,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/debug/my-data
 * Investigate why transactions still show up
 */
export const debugMyPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const studentId = req.user!.id;
        const allTransactions = await Transaction.find({ studentId });
        const allPayments = await Payment.find({ student: studentId });

        res.json({
            studentId,
            transactionCount: allTransactions.length,
            transactionStatuses: allTransactions.map(t => t.status),
            transactionIds: allTransactions.map(t => t._id),
            paymentCount: allPayments.length,
            payments: allPayments.map(p => ({ id: p._id, ref: p.transactionReference }))
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/:transactionId
 * Get a specific transaction by ID
 */
export const getTransactionById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const transaction = await Transaction.findById(req.params.transactionId);
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }
        res.json(transaction.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/receipt/:transactionId
 * Generate a receipt for a transaction
 */
export const generateReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const transaction = await Transaction.findById(req.params.transactionId);
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }

        const student = await User.findById(transaction.studentId);
        const receiptRef = `REC-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

        const receipt = {
            id: `rec-${Date.now()}`,
            transactionId: transaction.id,
            transaction: transaction.toJSON(),
            studentName: student ? `${student.firstName} ${student.lastName}` : 'Unknown Student',
            studentId: student?.studentId || 'N/A',
            programme: student?.programme || 'N/A',
            feeDescription: transaction.description,
            category: transaction.category,
            amount: transaction.amount,
            paymentDate: transaction.paidAt || transaction.createdAt,
            reference: receiptRef,
            transactionReference: transaction.reference,
            webhookVerified: transaction.webhookVerified,
            generatedAt: new Date().toISOString(),
        };

        res.json(receipt);
    } catch (error) {
        next(error);
    }
};

// ─── STUDENT PAYMENT INSIGHTS ─────────────────────────────────────────────────

/**
 * GET /api/payments/student-insights
 * Student: Get personal payment insights & analytics
 */
export const getStudentPaymentInsights = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const studentId = req.user!.id;

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
        sixMonthsAgo.setDate(1);
        sixMonthsAgo.setHours(0, 0, 0, 0);

        const now = new Date();

        // Parallelize fetching transaction history, general fee items, and student fees
        const [allCompleted, feeItems, studentFees] = await Promise.all([
            Transaction.find({
                studentId,
                status: { $in: ['completed', 'refunded'] },
                webhookVerified: true
            }).sort({ createdAt: 1 }),

            FeeItem.find({
                studentId,
                status: { $in: ['pending', 'partial'] },
            }).populate('feeTypeId'),

            StudentFee.find({
                student: studentId,
                status: { $in: ['unpaid', 'partial'] },
                dueDate: { $exists: true, $ne: null }
            }).populate('academicYear').sort({ semester: 1 })
        ]);

        // Filter in memory for recent transactions (last 6 months)
        const completedTransactions = allCompleted.filter(t => new Date(t.createdAt) >= sixMonthsAgo);

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthlyTrend: { label: string; amount: number }[] = [];

        for (let i = 0; i < 6; i++) {
            const d = new Date();
            d.setMonth(d.getMonth() - (5 - i));
            const mIdx = d.getMonth();
            const yr = d.getFullYear();
            const total = completedTransactions
                .filter(t => {
                    const td = new Date(t.createdAt);
                    return td.getMonth() === mIdx && td.getFullYear() === yr;
                })
                .reduce((sum, t) => {
                    const factor = t.status === 'refunded' ? -1 : 1;
                    return sum + (t.amount * factor);
                }, 0);
            monthlyTrend.push({ label: monthNames[mIdx], amount: Math.max(0, total) });
        }

        const methodCounts: Record<string, { count: number; total: number }> = {};
        allCompleted.forEach(t => {
            if (!methodCounts[t.paymentMethod]) methodCounts[t.paymentMethod] = { count: 0, total: 0 };
            const factor = t.status === 'refunded' ? -1 : 1;
            methodCounts[t.paymentMethod].count = Math.max(0, methodCounts[t.paymentMethod].count + (factor > 0 ? 1 : 0)); // Don't decrement count below 0, reversals don't decrement count of payments
            methodCounts[t.paymentMethod].total = Math.max(0, methodCounts[t.paymentMethod].total + (t.amount * factor));
        });
        const methodBreakdown = Object.entries(methodCounts).map(([method, data]) => ({
            method, count: data.count, total: data.total,
        }));

        // Category breakdown
        const categoryTotals: Record<string, number> = {};
        allCompleted.forEach(t => {
            const factor = t.status === 'refunded' ? -1 : 1;
            categoryTotals[t.category] = Math.max(0, (categoryTotals[t.category] || 0) + (t.amount * factor));
        });

        // Upcoming fee deadlines
        const feeItemDeadlines = feeItems
            .filter(f => f.dueDate)
            .map(f => {
                const feeType = f.feeTypeId as any;
                const dueDate = new Date(f.dueDate);
                const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                return { name: feeType?.name || 'Fee', category: feeType?.category || 'other', balance: f.balance, dueDate: f.dueDate, daysLeft };
            });

        // Only show the CURRENT semester's deadline:
        // → first unpaid/partial semester (Sem 1 until paid, then Sem 2)
        const currentStudentFee = studentFees[0] || null;
        const studentFeeDeadlines = currentStudentFee
            ? (() => {
                const sf = currentStudentFee;
                const yearLabel = (sf.academicYear as any)?.yearLabel || '';
                const dueDate = new Date(sf.dueDate!);
                const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                return [{ name: `Academic Fees - ${yearLabel} S${sf.semester}`, category: 'tuition', balance: sf.balance, dueDate: sf.dueDate, daysLeft }];
            })()
            : [];

        const upcomingDeadlines = [...feeItemDeadlines, ...studentFeeDeadlines]
            .sort((a, b) => a.daysLeft - b.daysLeft)
            .slice(0, 5);

        const totalPaidAll = allCompleted.reduce((sum, t) => {
            const factor = t.status === 'refunded' ? -1 : 1;
            return sum + (t.amount * factor);
        }, 0);
        const totalTransactions = allCompleted.filter(t => t.status === 'completed').length;
        const currentMonthPaid = completedTransactions
            .filter(t => {
                const td = new Date(t.createdAt);
                return td.getMonth() === now.getMonth() && td.getFullYear() === now.getFullYear();
            })
            .reduce((sum, t) => {
                const factor = t.status === 'refunded' ? -1 : 1;
                return sum + (t.amount * factor);
            }, 0);

        let streak = 0;
        for (let i = monthlyTrend.length - 1; i >= 0; i--) {
            if (monthlyTrend[i].amount > 0) streak++;
            else break;
        }

        res.json({
            monthlyTrend,
            methodBreakdown,
            categoryBreakdown: Object.entries(categoryTotals).map(([cat, total]) => ({ category: cat, total })),
            upcomingDeadlines,
            stats: {
                totalPaid: totalPaidAll,
                totalTransactions,
                currentMonthPaid,
                paymentStreak: streak,
                averagePayment: totalTransactions > 0 ? Math.round(totalPaidAll / totalTransactions) : 0,
            },
        });
    } catch (error) {
        next(error);
    }
};

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

/**
 * GET /api/payments/stats
 * Admin: Get payment statistics
 */
export const getPaymentStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, semester, startDate, endDate } = req.query;

        const filter: Record<string, any> = { status: 'completed', webhookVerified: true };
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate as string);
            if (endDate) filter.createdAt.$lte = new Date(endDate as string);
        }

        const [completedAgg, categoryAgg, methodAgg, transactionCount, studentCount, recentTransactions] = await Promise.all([
            Transaction.aggregate([
                { $match: filter },
                { $group: { _id: null, total: { $sum: '$amount' } } },
            ]),
            Transaction.aggregate([
                { $match: filter },
                { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Transaction.aggregate([
                { $match: filter },
                { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Transaction.countDocuments({ status: 'completed', webhookVerified: true }),
            User.countDocuments({ role: 'student' }),
            Transaction.find({ status: 'completed' })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('studentId', 'firstName lastName studentId'),
        ]);

        res.json({
            totalCollected: completedAgg[0]?.total || 0,
            breakdown: categoryAgg.reduce((acc: any, curr: any) => {
                acc[curr._id] = curr.total;
                return acc;
            }, {}),
            methodDistribution: methodAgg.map((m: any) => ({ method: m._id, total: m.total, count: m.count })),
            transactionCount,
            studentCount,
            recentTransactions: recentTransactions.map((t) => t.toJSON()),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/insights
 * Admin: Get detailed payment insights with filters
 */
export const getPaymentInsights = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { startDate, endDate, faculty, level, studentType, category, channel } = req.query;

        const dateFilter: Record<string, any> = { status: 'completed', webhookVerified: true };
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate as string);
            if (endDate) dateFilter.createdAt.$lte = new Date(endDate as string);
        }
        if (category) dateFilter.category = category;
        if (channel) dateFilter.paymentMethod = channel;

        const [revenueByCategory, methodDistribution, dailyRevenue, channelBreakdown] = await Promise.all([
            Transaction.aggregate([
                { $match: dateFilter },
                { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } },
            ]),
            Transaction.aggregate([
                { $match: dateFilter },
                { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } },
            ]),
            Transaction.aggregate([
                {
                    $match: {
                        ...dateFilter,
                        createdAt: {
                            $gte: dateFilter.createdAt?.$gte || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                        },
                    },
                },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
            ]),
            Transaction.aggregate([
                { $match: dateFilter },
                { $group: { _id: '$paymentChannel', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
        ]);

        res.json({
            revenueByCategory: revenueByCategory.map(item => ({ category: item._id, amount: item.total, count: item.count })),
            methodDistribution: methodDistribution.map(item => ({ method: item._id, amount: item.total, count: item.count })),
            dailyRevenue: dailyRevenue.map(item => ({ date: item._id, amount: item.total, count: item.count })),
            channelBreakdown: channelBreakdown.map(item => ({ channel: item._id, amount: item.total, count: item.count })),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/all
 * Admin: Get all transactions with advanced filters
 */
export const getAllTransactions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const skip = (page - 1) * limit;

        const filter: Record<string, any> = {};
        
        // Status mapping for different verify lists
        if (req.query.status && req.query.status !== 'all') {
            const statusStr = req.query.status as string;
            if (statusStr === 'pending_verification') {
                filter.status = { $in: ['pending', 'processing'] };
            } else if (statusStr === 'manually_verified') {
                filter.$or = [
                    { status: 'completed', 'metadata.manuallyVerified': true },
                    { paymentChannel: 'manual' }
                ];
            } else if (statusStr === 'completed') {
                filter.status = 'completed';
                filter.paymentChannel = { $ne: 'manual' };
                filter['metadata.manuallyVerified'] = { $ne: true };
            } else {
                filter.status = statusStr;
            }
        }
        
        // Programme filtering
        if (req.query.programme && req.query.programme !== 'all') {
            const matchedStudents = await User.find({
                programme: { $regex: req.query.programme as string, $options: 'i' }
            }).select('_id').lean();
            filter.studentId = { $in: matchedStudents.map(s => s._id) };
        }

        if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
        if (req.query.paymentMethod && req.query.paymentMethod !== 'all') filter.paymentMethod = req.query.paymentMethod;
        if (req.query.paymentChannel && req.query.paymentChannel !== 'all') filter.paymentChannel = req.query.paymentChannel;
        if (req.query.webhookVerified) filter.webhookVerified = req.query.webhookVerified === 'true';

        // Date range
        if (req.query.startDate || req.query.endDate) {
            filter.createdAt = {};
            if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
            if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
        }

        // Search by student ID string (e.g. 'PUC/CS/001') or transaction reference
        if (req.query.studentId) {
            const searchTerm = (req.query.studentId as string).trim();

            // Check if it looks like a transaction reference
            if (searchTerm.startsWith('PAY_') || searchTerm.startsWith('REF_')) {
                filter.reference = { $regex: searchTerm, $options: 'i' };
            } else {
                // Look up user by studentId string first
                const matchedStudents = await User.find({
                    $or: [
                        { studentId: { $regex: searchTerm, $options: 'i' } },
                        { firstName: { $regex: searchTerm, $options: 'i' } },
                        { lastName: { $regex: searchTerm, $options: 'i' } },
                        { email: { $regex: searchTerm, $options: 'i' } },
                    ]
                }).select('_id').lean();

                if (matchedStudents.length > 0) {
                    filter.studentId = { $in: matchedStudents.map(s => s._id) };
                } else {
                    // No matching students — also search by reference
                    filter.reference = { $regex: searchTerm, $options: 'i' };
                }
            }
        }

        const [transactions, total] = await Promise.all([
            Transaction.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('studentId', 'firstName lastName studentId email programme level stream nationality'),
            Transaction.countDocuments(filter),
        ]);

        res.json({
            transactions: transactions.map((t) => {
                const json = t.toJSON() as any;
                // Rename populated field for frontend consistency
                if (json.studentId && typeof json.studentId === 'object') {
                    json.student = json.studentId;
                }
                return json;
            }),
            total,
            page,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/export
 * Admin: Export transactions as CSV
 */
export const exportReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const filter: Record<string, any> = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.category) filter.category = req.query.category;
        if (req.query.startDate || req.query.endDate) {
            filter.createdAt = {};
            if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
            if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate as string);
        }

        const transactions = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .populate('studentId', 'firstName lastName studentId email programme level stream nationality');

        const csvHeader = 'Reference,Student Name,Student ID,Programme,Level,Stream,Amount (GHS),Category,Method,Channel,Status,Webhook Verified,Date\n';
        const csvRows = transactions.map((t) => {
            const student = t.studentId as any;
            const name = student?.firstName ? `${student.firstName} ${student.lastName}` : 'N/A';
            return `${t.reference},"${name}",${student?.studentId || 'N/A'},"${student?.programme || 'N/A'}",${student?.level || 'N/A'},${student?.stream || 'N/A'},${t.amount},${t.category},${t.paymentMethod},${t.paymentChannel},${t.status},${t.webhookVerified},${t.createdAt.toISOString()}`;
        });

        const csv = csvHeader + csvRows.join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions-report.csv');
        res.send(csv);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/daily-summary
 * Admin: Get today's revenue summary
 */
export const getDailySummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [summary, byCategory, byMethod] = await Promise.all([
            Transaction.aggregate([
                { $match: { status: 'completed', webhookVerified: true, createdAt: { $gte: today, $lt: tomorrow } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Transaction.aggregate([
                { $match: { status: 'completed', webhookVerified: true, createdAt: { $gte: today, $lt: tomorrow } } },
                { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Transaction.aggregate([
                { $match: { status: 'completed', webhookVerified: true, createdAt: { $gte: today, $lt: tomorrow } } },
                { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
        ]);

        const [pending, failed] = await Promise.all([
            Transaction.countDocuments({ status: 'pending', createdAt: { $gte: today, $lt: tomorrow } }),
            Transaction.countDocuments({ status: 'failed', createdAt: { $gte: today, $lt: tomorrow } }),
        ]);

        const totalToday = (summary[0]?.count || 0) + pending + failed;
        const successRate = totalToday > 0 ? Math.round((summary[0]?.count || 0) / totalToday * 100) : 0;

        res.json({
            date: today.toISOString().split('T')[0],
            totalRevenue: summary[0]?.total || 0,
            totalTransactions: summary[0]?.count || 0,
            pendingCount: pending,
            failedCount: failed,
            successRate,
            byCategory: byCategory.map((c: any) => ({ category: c._id, total: c.total, count: c.count })),
            byMethod: byMethod.map((m: any) => ({ method: m._id, total: m.total, count: m.count })),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/audit-logs
 * Admin: Get audit logs for security review
 */
export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const skip = (page - 1) * limit;

        const filter: Record<string, any> = {};
        if (req.query.action) filter.action = req.query.action;
        if (req.query.isError === 'true') filter.isError = true;
        if (req.query.reference) filter.reference = req.query.reference;

        const [logs, total] = await Promise.all([
            AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            AuditLog.countDocuments(filter),
        ]);

        res.json({ logs: logs.map(l => l.toJSON()), total, page });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/payments/callback/:reference
 * 
 * Public callback URL registered with Paystack.
 * Paystack redirects the customer's browser here on success.
 * We verify the transaction and output a clean HTML page that the WebView intercepts.
 */
export const handlePaymentCallback = async (req: Request, res: Response): Promise<void> => {
    try {
        const { reference } = req.params;
        const refStr = Array.isArray(reference) ? reference[0] : reference;
        let transaction = await Transaction.findOne({ reference: refStr });
        if (!transaction) {
            res.status(404).send('<h3>Transaction not found</h3>');
            return;
        }

        // Verify with Paystack if not already completed
        if (transaction.status !== 'completed') {
            try {
                const psVerify = await PaystackService.verifyTransaction(refStr);
                if (psVerify.status && psVerify.data?.status === 'success') {
                    const amountGHSPaid = psVerify.data.amount / 100;
                    if (Math.abs(amountGHSPaid - transaction.amountExpected) <= 0.01) {
                        const channel = psVerify.data.channel || 'paystack';
                        const gatewayResponse = psVerify.data.gateway_response || 'Approved';
                        const paidAt = psVerify.data.paid_at ? new Date(psVerify.data.paid_at) : new Date();
                        const providerRef = psVerify.data.id?.toString() || 'N/A';

                        await finalizePaymentSuccess(transaction, paidAt, providerRef, amountGHSPaid, channel, gatewayResponse);
                        // Refresh the transaction state
                        transaction = (await Transaction.findOne({ reference: refStr })) || transaction;
                    }
                }
            } catch (err) {
                console.error('[handlePaymentCallback] Paystack verify error:', err);
            }
        }

        // Return a simple, beautiful success page with blue and gold institutional theme
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Payment Successful</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        background-color: #F8F9FA;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .card {
                        background: white;
                        padding: 30px;
                        border-radius: 16px;
                        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
                        text-align: center;
                        max-width: 320px;
                        width: 100%;
                    }
                    .icon {
                        width: 72px;
                        height: 72px;
                        background: #10B981;
                        color: white;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 20px;
                        font-size: 36px;
                    }
                    h2 {
                        color: #1B3A5C;
                        margin: 0 0 10px;
                        font-weight: 700;
                    }
                    p {
                        color: #64748B;
                        font-size: 14px;
                        margin: 0 0 20px;
                        line-height: 1.5;
                    }
                    .ref {
                        font-size: 11px;
                        color: #94A3B8;
                        background: #F1F5F9;
                        padding: 6px 12px;
                        border-radius: 8px;
                        display: inline-block;
                    }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✓</div>
                    <h2>Payment Confirmed</h2>
                    <p>Your transaction was verified successfully. You can return to the app.</p>
                    <span class="ref">Ref: ${refStr}</span>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('[handlePaymentCallback] Handler error:', error);
        res.status(500).send('<h3>An error occurred processing the callback</h3>');
    }
};

/**
 * GET /api/payments/cancel/:reference
 * 
 * Public callback URL registered with Paystack.
 * Paystack redirects the customer's browser here when they click cancel.
 * We mark the transaction as cancelled and return a clean HTML page.
 */
export const handlePaymentCancelCallback = async (req: Request, res: Response): Promise<void> => {
    try {
        const { reference } = req.params;
        const refStr = Array.isArray(reference) ? reference[0] : reference;
        const transaction = await Transaction.findOne({ reference: refStr });
        if (!transaction) {
            res.status(404).send('<h3>Transaction not found</h3>');
            return;
        }

        if (['pending', 'processing'].includes(transaction.status)) {
            // ── CRITICAL: Verify with Paystack BEFORE marking as cancelled ──
            // MoMo payments can complete milliseconds before the cancel redirect fires.
            // A student who entered their PIN and had money deducted must NOT be marked cancelled.
            let paystackStatus: string | null = null;
            try {
                const psVerify = await PaystackService.verifyTransaction(refStr);
                paystackStatus = psVerify.data?.status || null;

                if (psVerify.status && psVerify.data?.status === 'success') {
                    // Payment was actually COMPLETED on Paystack — finalize it!
                    const amountGHSPaid = psVerify.data.amount / 100;
                    if (Math.abs(amountGHSPaid - transaction.amountExpected) <= 0.01) {
                        const channel = psVerify.data.channel || 'paystack';
                        const gatewayResponse = psVerify.data.gateway_response || 'Approved';
                        const paidAt = psVerify.data.paid_at ? new Date(psVerify.data.paid_at) : new Date();
                        const providerRef = psVerify.data.id?.toString() || 'N/A';
                        await finalizePaymentSuccess(transaction, paidAt, providerRef, amountGHSPaid, channel, gatewayResponse);
                        console.log(`[CancelCallback] Intercepted: ${refStr} was actually PAID. Finalized instead of cancelling.`);
                        // Show the success page instead of the cancel page
                        res.send(`
                            <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>Payment Confirmed</title>
                            <style>body{font-family:-apple-system,sans-serif;background:#F0FDF4;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
                            .card{background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center;max-width:320px;width:100%}
                            .icon{width:72px;height:72px;background:#10B981;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:36px}
                            h2{color:#065F46;margin:0 0 10px;font-weight:700}p{color:#64748B;font-size:14px;margin:0 0 20px;line-height:1.5}
                            .ref{font-size:11px;color:#94A3B8;background:#F1F5F9;padding:6px 12px;border-radius:8px;display:inline-block}</style></head>
                            <body><div class="card"><div class="icon">✓</div>
                            <h2>Payment Confirmed!</h2>
                            <p>Your payment was successfully processed. Return to the app to view your updated balance.</p>
                            <span class="ref">Ref: ${refStr}</span></div></body></html>
                        `);
                        return;
                    }
                }

                // Paystack confirmed abandoned/failed — safe to cancel
                if (paystackStatus === 'abandoned' || paystackStatus === 'failed') {
                    transaction.status = 'cancelled';
                    transaction.metadata = {
                        ...transaction.metadata,
                        cancelledAt: new Date().toISOString(),
                        cancelledBy: 'student_redirect',
                        paystackStatus,
                    };
                    await transaction.save();
                } else {
                    // Paystack returned pending or unknown — leave as pending (safer)
                    transaction.status = 'pending';
                    transaction.metadata = {
                        ...transaction.metadata,
                        cancelRedirectAt: new Date().toISOString(),
                        paystackStatus: paystackStatus || 'unknown',
                    };
                    await transaction.save();
                }
            } catch (psError: any) {
                // Cannot reach Paystack — leave as pending rather than wrongly cancelling
                console.error('[handlePaymentCancelCallback] Paystack verify failed:', psError.message);
                transaction.status = 'pending';
                transaction.metadata = {
                    ...transaction.metadata,
                    cancelRedirectAt: new Date().toISOString(),
                    cancelVerifyError: psError.message,
                };
                await transaction.save();
            }

            const finalStatus = transaction.status;

            // Emit socket update
            emitFeeUpdate({
                type: 'student_fee',
                action: 'updated',
                studentId: transaction.studentId.toString(),
                data: { reference: refStr, status: finalStatus }
            });

            if (finalStatus === 'cancelled') {
                try {
                    const studentUser = await User.findById(transaction.studentId).select('firstName lastName');
                    if (studentUser) {
                        emitPaymentCancelled({
                            transactionId: transaction._id.toString(),
                            studentId: transaction.studentId.toString(),
                            studentName: `${studentUser.firstName} ${studentUser.lastName}`,
                            amount: transaction.amount,
                            description: transaction.description,
                            reference: transaction.reference,
                            category: transaction.category,
                        });
                    }
                } catch (err) {
                    console.error('[handlePaymentCancelCallback] Socket emit failed:', err);
                }
            }
        }

        // Return a simple cancel page
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Payment Cancelled</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        background-color: #F8F9FA;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .card {
                        background: white;
                        padding: 30px;
                        border-radius: 16px;
                        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
                        text-align: center;
                        max-width: 320px;
                        width: 100%;
                    }
                    .icon {
                        width: 72px;
                        height: 72px;
                        background: #64748B;
                        color: white;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 20px;
                        font-size: 36px;
                    }
                    h2 {
                        color: #1B3A5C;
                        margin: 0 0 10px;
                        font-weight: 700;
                    }
                    p {
                        color: #64748B;
                        font-size: 14px;
                        margin: 0 0 20px;
                        line-height: 1.5;
                    }
                    .ref {
                        font-size: 11px;
                        color: #94A3B8;
                        background: #F1F5F9;
                        padding: 6px 12px;
                        border-radius: 8px;
                        display: inline-block;
                    }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✕</div>
                    <h2>Payment Cancelled</h2>
                    <p>You cancelled the payment request. You can return to the app.</p>
                    <span class="ref">Ref: ${refStr}</span>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('[handlePaymentCancelCallback] Handler error:', error);
        res.status(500).send('<h3>An error occurred processing the cancellation</h3>');
    }
};

// ─── GET PAYMENT STATUS (for frontend polling) ────────────────────────────────

/**
 * GET /api/payments/status/:reference
 *
 * Lightweight status endpoint polled by the mobile app while waiting for
 * Paystack/webhook confirmation. Returns only the status fields needed
 * to decide what step to show.
 */
export const getPaymentStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { reference } = req.params;
        const transaction = await Transaction.findOne({ reference });
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }
        // Only the owning student or admin may poll
        if (req.user!.role !== 'admin' && transaction.studentId.toString() !== req.user!.id.toString()) {
            res.status(403).json({ message: 'Unauthorized.' });
            return;
        }
        res.json({
            id: transaction._id,
            _id: transaction._id,
            reference: transaction.reference,
            status: transaction.status,
            webhookVerified: transaction.webhookVerified,
            amount: transaction.amount,
            paidAt: transaction.paidAt || null,
            category: transaction.category,
            description: transaction.description,
        });
    } catch (error) {
        next(error);
    }
};

// ─── ADMIN: VERIFY & CONFIRM PAYMENT ─────────────────────────────────────────

/**
 * POST /api/payments/admin/verify
 * Admin: Search for a transaction by reference / receipt / student, then verify
 * with Paystack and finalize if successful.
 */
export const adminVerifyAndConfirm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const admin = req.user!;
        const { reference, receiptNumber, studentQuery } = req.body;

        let transaction: any = null;

        if (reference) {
            transaction = await Transaction.findOne({ reference });
        } else if (receiptNumber) {
            transaction = await Transaction.findOne({ 'metadata.receiptNumber': receiptNumber });
        } else if (studentQuery) {
            const matchedStudent = await User.findOne({
                $or: [
                    { studentId: { $regex: studentQuery, $options: 'i' } },
                    { firstName: { $regex: studentQuery, $options: 'i' } },
                    { email: { $regex: studentQuery, $options: 'i' } },
                ]
            });
            if (matchedStudent) {
                transaction = await Transaction.findOne({
                    studentId: matchedStudent._id,
                    status: { $in: ['pending', 'processing', 'cancelled'] }
                }).sort({ createdAt: -1 });
            }
        }

        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found. Try searching by reference, receipt number, or student ID.' });
            return;
        }

        // Already completed — just return it
        if (transaction.status === 'completed' && transaction.webhookVerified) {
            res.json({ message: 'Transaction is already verified and completed.', transaction: transaction.toJSON() });
            return;
        }

        // Verify with Paystack
        let psVerify: any;
        try {
            psVerify = await PaystackService.verifyTransaction(transaction.reference);
        } catch (psErr: any) {
            res.status(502).json({ message: `Could not reach Paystack: ${psErr.message}` });
            return;
        }

        if (!psVerify.status || psVerify.data?.status !== 'success') {
            await AuditLog.create({
                action: 'admin_verify_not_success',
                reference: transaction.reference,
                details: {
                    adminName: `${admin.firstName} ${admin.lastName}`,
                    paystackStatus: psVerify.data?.status || 'unknown',
                },
                isError: false,
            }).catch(console.error);
            res.status(400).json({
                message: `Paystack reports this payment as "${psVerify.data?.status || 'not found'}". Cannot confirm.`,
                paystackStatus: psVerify.data?.status,
                transaction: transaction.toJSON(),
            });
            return;
        }

        // Finalize
        const amountGHSPaid = psVerify.data.amount / 100;
        const channel = psVerify.data.channel || 'paystack';
        const gatewayResponse = psVerify.data.gateway_response || 'Admin Verified';
        const paidAt = psVerify.data.paid_at ? new Date(psVerify.data.paid_at) : new Date();
        const providerRef = psVerify.data.id?.toString() || 'N/A';

        await finalizePaymentSuccess(transaction, paidAt, providerRef, amountGHSPaid, channel, gatewayResponse);

        await AuditLog.create({
            action: 'admin_payment_confirmed',
            reference: transaction.reference,
            studentId: transaction.studentId,
            amount: amountGHSPaid,
            details: {
                adminName: `${admin.firstName} ${admin.lastName}`,
                paystackId: providerRef,
                gatewayResponse,
            },
            isError: false,
        }).catch(console.error);

        const updated = await Transaction.findOne({ reference: transaction.reference });
        res.json({ message: 'Payment verified and confirmed successfully.', transaction: updated?.toJSON() });
    } catch (error) {
        next(error);
    }
};

// ─── ADMIN: ADJUST BALANCE ────────────────────────────────────────────────────

/**
 * POST /api/payments/admin/adjust-balance
 * Admin: Manually credit or debit a student's fee balance.
 * adjustment > 0 = credit (scholarship, overpayment return)
 * adjustment < 0 = deduction
 */
export const adminAdjustBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const admin = req.user!;
        const { studentFeeId, feeItemId, adjustment, reason, notes } = req.body;

        if (!reason || reason.trim().length < 5) {
            res.status(400).json({ message: 'A reason of at least 5 characters is required.' });
            return;
        }
        if (typeof adjustment !== 'number' || adjustment === 0) {
            res.status(400).json({ message: 'adjustment must be a non-zero number (GHS).' });
            return;
        }

        let adjustedRecord: any = null;
        let studentId: any = null;
        let description = '';
        let previousBalance = 0;
        let newBalance = 0;
        let category: FeeCategory = 'academic';

        if (studentFeeId) {
            const sf = await StudentFee.findById(studentFeeId);
            if (!sf) { res.status(404).json({ message: 'StudentFee not found.' }); return; }
            studentId = sf.student;
            previousBalance = sf.balance;

            // adjustment > 0 means we credit (increase amountPaid, decrease balance)
            sf.amountPaid = Math.max(0, sf.amountPaid + adjustment);
            sf.balance = Math.max(0, sf.totalFee - sf.amountPaid);
            sf.status = sf.balance === 0 ? 'paid' : sf.amountPaid > 0 ? 'partial' : 'unpaid';
            await sf.save();
            adjustedRecord = sf;
            newBalance = sf.balance;
            description = 'Academic fee balance adjustment';
            category = 'academic';
        } else if (feeItemId) {
            const fi = await FeeItem.findById(feeItemId);
            if (!fi) { res.status(404).json({ message: 'FeeItem not found.' }); return; }
            studentId = fi.studentId;
            previousBalance = fi.balance;

            fi.amountPaid = Math.max(0, fi.amountPaid + adjustment);
            fi.balance = Math.max(0, fi.totalAmount - fi.amountPaid);
            fi.status = fi.balance === 0 ? 'paid' : fi.amountPaid > 0 ? 'partial' : 'pending';
            await fi.save();
            adjustedRecord = fi;
            newBalance = fi.balance;
            description = 'Fee item balance adjustment';

            const ft = await FeeType.findById(fi.feeTypeId);
            category = resolveFeeCategory(ft, false);
            description = ft?.name ? `${ft.name} balance adjustment` : description;
        } else {
            res.status(400).json({ message: 'Either studentFeeId or feeItemId is required.' });
            return;
        }

        // Create transaction log so adjustment is reflected in student history, charts, and dashboard activity
        const txReference = generateReference('ADJ');
        await Transaction.create({
            studentId,
            feeItemId: feeItemId || undefined,
            studentFeeId: studentFeeId || undefined,
            amount: Math.abs(adjustment),
            amountExpected: Math.abs(adjustment),
            paymentMethod: 'bank_transfer',
            paymentChannel: 'manual',
            status: adjustment > 0 ? 'completed' : 'refunded',
            reference: txReference,
            category,
            description: `${description}: ${reason} (${adjustment > 0 ? 'Credit' : 'Debit'})`,
            webhookVerified: true,
            paidAt: new Date(),
            metadata: {
                recordedBy: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                adjustmentType: adjustment > 0 ? 'credit' : 'debit',
                previousBalance,
                newBalance,
                reason,
                notes: notes || '',
            }
        }).catch(console.error);

        await AuditLog.create({
            action: 'manual_balance_adjustment',
            studentId,
            amount: adjustment,
            details: {
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                description,
                reason,
                notes: notes || '',
                adjustmentType: adjustment > 0 ? 'credit' : 'debit',
                previousBalance,
                newBalance,
                timestamp: new Date().toISOString()
            },
            isError: false,
        }).catch(console.error);

        // Create notification for the student
        await Notification.create({
            recipientId: studentId,
            title: adjustment > 0 ? 'Balance Credited 💰' : 'Balance Adjusted ⚠️',
            body: `Your fee account was adjusted by GHS ${Math.abs(adjustment).toFixed(2)}. Reason: ${reason}`,
            type: adjustment > 0 ? 'success' : 'warning',
            data: { adjustedBy: 'admin' },
        }).catch(console.error);

        emitFeeUpdate({
            type: 'student_fee',
            action: 'updated',
            studentId: studentId.toString(),
            data: { adjustedBy: 'admin', reason }
        });

        res.json({
            message: `Balance adjusted by ${adjustment > 0 ? '+' : ''}${adjustment} GHS successfully.`,
            record: adjustedRecord,
        });
    } catch (error) {
        next(error);
    }
};

// ─── ADMIN: RECORD MANUAL PAYMENT ────────────────────────────────────────────

/**
 * POST /api/payments/admin/record-payment
 * Admin: Record a manual/offline payment (e.g. cash, bank deposit receipt).
 * Creates a completed Transaction + Payment + updates the ledger.
 */
export const adminRecordPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const admin = req.user!;
        const { studentId, studentFeeId, feeItemId, amount, paymentMethod, reference: customRef, receiptNumber, notes } = req.body;

        if (!studentId || !amount || !paymentMethod) {
            res.status(400).json({ message: 'studentId, amount, and paymentMethod are required.' });
            return;
        }

        const student = await User.findById(studentId);
        if (!student) { res.status(404).json({ message: 'Student not found.' }); return; }

        const reference = customRef || generateReference('MAN');

        // Duplicate reference guard
        const existing = await Transaction.findOne({ reference });
        if (existing) {
            res.status(409).json({ message: `A transaction with reference "${reference}" already exists.` });
            return;
        }

        let feeItem: any = null;
        let academicFee: any = null;
        let category: FeeCategory = 'academic';
        let description = notes || 'Manual Payment by Admin';

        if (feeItemId) {
            feeItem = await FeeItem.findById(feeItemId);
            if (feeItem) {
                const ft = await FeeType.findById(feeItem.feeTypeId);
                category = resolveFeeCategory(ft, false);
                description = ft?.name ? `${ft.name} — ${notes || 'Manual Payment'}` : description;
            }
        } else if (studentFeeId) {
            academicFee = await StudentFee.findById(studentFeeId);
            category = 'academic';
            description = `Academic Fee — ${notes || 'Manual Payment'}`;
        }

        const amountNum = parseFloat(amount);

        const transaction = await Transaction.create({
            studentId,
            feeItemId: feeItem?._id,
            studentFeeId: academicFee?._id,
            amount: amountNum,
            amountExpected: amountNum,
            paymentMethod,
            paymentChannel: 'manual',
            status: 'completed',
            reference,
            category,
            description,
            webhookVerified: true,
            paidAt: new Date(),
            metadata: {
                recordedBy: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                receiptNumber: receiptNumber || null,
                notes: notes || '',
                manualEntry: true,
            },
        });

        await Payment.findOneAndUpdate(
            { transactionReference: reference },
            {
                student: studentId,
                amount: amountNum,
                paymentMethod,
                transactionReference: reference,
                status: 'completed',
                paymentDate: new Date(),
                description,
                studentFee: academicFee?._id,
                feeItem: feeItem?._id,
                metadata: { manualEntry: true, receiptNumber: receiptNumber || null },
            },
            { upsert: true, new: true }
        );

        await updateLedger(feeItem, academicFee, amountNum, category);

        // Create notification for the student
        await Notification.create({
            recipientId: studentId,
            title: 'Payment Recorded Offline 🏦',
            body: `A manual payment of GHS ${amountNum.toFixed(2)} was recorded on your account. Reference: ${reference}`,
            type: 'success',
            data: { transactionId: transaction._id },
        }).catch(console.error);

        await AuditLog.create({
            action: 'admin_manual_payment',
            reference,
            studentId,
            amount: amountNum,
            category,
            details: {
                adminName: `${admin.firstName} ${admin.lastName}`,
                paymentMethod,
                receiptNumber: receiptNumber || null,
                notes: notes || '',
            },
            isError: false,
        }).catch(console.error);

        emitFeeUpdate({
            type: 'student_fee',
            action: 'updated',
            studentId: studentId.toString(),
            data: { reference, amount: amountNum, status: 'completed', recordedBy: 'admin' }
        });

        res.status(201).json({
            message: 'Manual payment recorded successfully.',
            transaction: transaction.toJSON(),
            reference,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get outstanding balance for a fee record.
 */
async function getOutstandingBalance(studentId: string, studentFeeId?: any, feeItemId?: any): Promise<number> {
    try {
        if (feeItemId) {
            const fi = await FeeItem.findById(feeItemId);
            return fi ? fi.balance : 0;
        } else if (studentFeeId) {
            const sf = await StudentFee.findById(studentFeeId);
            return sf ? sf.balance : 0;
        }
        return 0;
    } catch {
        return 0;
    }
}

/**
 * POST /api/payments/admin/manual-approve
 * Admin manually verifies and approves a payment when webhook has failed or delayed.
 * Marks the payment as Completed with 'manuallyVerified' metadata.
 */
export const adminManualApprove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const admin = req.user!;
        const { studentId, studentFeeId, feeItemId, amount, reference, receiptNumber, notes } = req.body;

        if (!studentId || !amount || !reference || !notes) {
            res.status(400).json({ message: 'studentId, amount, reference, and notes are required.' });
            return;
        }

        const student = await User.findById(studentId);
        if (!student) {
            res.status(404).json({ message: 'Student not found.' });
            return;
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            res.status(400).json({ message: 'Please provide a valid amount.' });
            return;
        }

        // Duplicate payment protection
        const existingTx = await Transaction.findOne({ reference });
        if (existingTx) {
            if (existingTx.status === 'completed') {
                res.status(409).json({
                    message: `Warning: This Paystack reference (${reference}) has already been successfully processed and credited.`,
                    transaction: existingTx.toJSON()
                });
                return;
            }

            // Existing pending/processing/cancelled/failed transaction -> update it
            const previousBalance = await getOutstandingBalance(studentId, existingTx.studentFeeId, existingTx.feeItemId);
            
            existingTx.status = 'completed';
            existingTx.webhookVerified = true;
            existingTx.paidAt = new Date();
            existingTx.amount = amountNum;
            existingTx.metadata = {
                ...existingTx.metadata,
                manuallyVerified: true,
                verifiedBy: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                receiptNumber: receiptNumber || null,
                notes: notes || '',
                approvedAt: new Date().toISOString()
            };
            await existingTx.save();

            // Create payment
            await Payment.findOneAndUpdate(
                { transactionReference: reference },
                {
                    student: studentId,
                    amount: amountNum,
                    paymentMethod: existingTx.paymentMethod || 'mobile_money',
                    transactionReference: reference,
                    status: 'completed',
                    paymentDate: new Date(),
                    description: existingTx.description,
                    studentFee: existingTx.studentFeeId,
                    feeItem: existingTx.feeItemId,
                    metadata: { manuallyVerified: true, receiptNumber: receiptNumber || null },
                },
                { upsert: true, new: true }
            );

            // Update ledger
            let feeItem: any = null;
            let academicFee: any = null;
            if (existingTx.feeItemId) feeItem = await FeeItem.findById(existingTx.feeItemId);
            if (existingTx.studentFeeId) academicFee = await StudentFee.findById(existingTx.studentFeeId);
            await updateLedger(feeItem, academicFee, amountNum, existingTx.category);

            const newBalance = await getOutstandingBalance(studentId, existingTx.studentFeeId, existingTx.feeItemId);

            // Create Audit Log
            await AuditLog.create({
                action: 'payment_success', // Use existing success action or custom
                reference,
                studentId,
                amount: amountNum,
                category: existingTx.category,
                isError: false,
                details: {
                    adminId: admin.id,
                    adminName: `${admin.firstName} ${admin.lastName}`,
                    previousBalance,
                    newBalance,
                    notes,
                    receiptNumber,
                    paystackReference: reference,
                    manuallyVerified: true,
                    timestamp: new Date().toISOString()
                }
            });

            emitFeeUpdate({
                type: 'student_fee',
                action: 'updated',
                studentId: studentId.toString(),
                data: { reference, amount: amountNum, status: 'completed', verifiedBy: 'admin' }
            });

            res.json({
                message: 'Payment manually verified and approved successfully.',
                transaction: existingTx.toJSON()
            });
            return;
        }

        // If transaction does NOT exist in DB, create a new completed one
        let feeItem: any = null;
        let academicFee: any = null;
        let category: FeeCategory = 'academic';
        let description = notes || 'Manually Verified Paystack Payment';

        if (feeItemId) {
            feeItem = await FeeItem.findById(feeItemId);
            if (feeItem) {
                const ft = await FeeType.findById(feeItem.feeTypeId);
                category = resolveFeeCategory(ft, false);
                description = ft?.name ? `${ft.name} — Manually Verified` : description;
            }
        } else if (studentFeeId) {
            academicFee = await StudentFee.findById(studentFeeId);
            category = 'academic';
            description = `Academic Fee — Manually Verified`;
        }

        const previousBalance = await getOutstandingBalance(studentId, studentFeeId, feeItemId);

        const transaction = await Transaction.create({
            studentId,
            feeItemId: feeItem?._id,
            studentFeeId: academicFee?._id,
            amount: amountNum,
            amountExpected: amountNum,
            paymentMethod: 'mobile_money',
            paymentChannel: 'paystack',
            status: 'completed',
            reference,
            category,
            description,
            webhookVerified: true,
            paidAt: new Date(),
            metadata: {
                manuallyVerified: true,
                verifiedBy: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                receiptNumber: receiptNumber || null,
                notes: notes || '',
                approvedAt: new Date().toISOString()
            },
        });

        await Payment.findOneAndUpdate(
            { transactionReference: reference },
            {
                student: studentId,
                amount: amountNum,
                paymentMethod: 'mobile_money',
                transactionReference: reference,
                status: 'completed',
                paymentDate: new Date(),
                description,
                studentFee: academicFee?._id,
                feeItem: feeItem?._id,
                metadata: { manuallyVerified: true, receiptNumber: receiptNumber || null },
            },
            { upsert: true, new: true }
        );

        await updateLedger(feeItem, academicFee, amountNum, category);
        const newBalance = await getOutstandingBalance(studentId, studentFeeId, feeItemId);

        await AuditLog.create({
            action: 'payment_success',
            reference,
            studentId,
            amount: amountNum,
            category,
            isError: false,
            details: {
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`,
                previousBalance,
                newBalance,
                notes,
                receiptNumber,
                paystackReference: reference,
                manuallyVerified: true,
                timestamp: new Date().toISOString()
            }
        });

        emitFeeUpdate({
            type: 'student_fee',
            action: 'updated',
            studentId: studentId.toString(),
            data: { reference, amount: amountNum, status: 'completed', verifiedBy: 'admin' }
        });

        res.status(201).json({
            message: 'Manual payment verification recorded successfully.',
            transaction: transaction.toJSON(),
            reference
        });
    } catch (error) {
        next(error);
    }
};


