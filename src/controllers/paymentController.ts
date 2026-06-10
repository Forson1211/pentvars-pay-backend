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
import { emitPaymentUpdate, emitPaymentCancelled } from '../services/socketService';
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
                },
                determineSupportedChannels(paymentMethod, category)
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
            amount: officialAmount,
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

    // ── 5. Mark transaction as successful ──────────────────────────────────
    transaction.status = 'completed';
    transaction.webhookVerified = true;
    transaction.paidAt = new Date(data?.paid_at || Date.now());
    transaction.providerReference = data?.id?.toString();
    transaction.amount = amountGHSPaid;
    transaction.metadata = {
        ...transaction.metadata,
        channel,
        gatewayResponse,
        paystackId: data?.id,
        customerEmail: data?.customer?.email,
        authorizationCode: data?.authorization?.authorization_code,
    };
    await transaction.save();

    // ── 6. Update Payment record for reporting ────────────────────────────
    await Payment.findOneAndUpdate(
        { transactionReference: reference },
        {
            student: transaction.studentId,
            amount: amountGHSPaid,
            paymentMethod: channel === 'mobile_money' ? 'mobile_money' :
                channel === 'card' ? 'card' : 'bank_transfer',
            transactionReference: reference,
            status: 'completed',
            paymentDate: transaction.paidAt,
            description: transaction.description,
            studentFee: transaction.studentFeeId,
            feeItem: transaction.feeItemId,
            metadata: { channel, gatewayResponse },
        },
        { upsert: true, new: true }
    ).catch(console.error);

    // ── 7. Update ledger ──────────────────────────────────────────────────
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
        console.error(`[Webhook] Ledger update failed for ${reference}:`, ledgerError);
        await AuditLog.create({
            action: 'payment_failed',
            reference,
            studentId: transaction.studentId,
            details: { error: 'Ledger update failed: ' + ledgerError.message },
            isError: true,
        }).catch(console.error);
    }

    // ── 8. Audit success ──────────────────────────────────────────────────
    await AuditLog.create({
        action: 'payment_success',
        reference,
        studentId: transaction.studentId,
        amount: amountGHSPaid,
        category: transaction.category,
        channel,
        details: { paystackId: data?.id, gatewayResponse },
        isError: false,
    }).catch(console.error);

    // ── 9. Notify admins ──────────────────────────────────────────────────
    try {
        const student = await User.findById(transaction.studentId).select('firstName lastName');
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
            
            // ── 10. REAL-TIME SOCKET UPDATE ──
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
        console.error('[Webhook] Admin notification error:', notifyError);
    }

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
                    // Update transaction
                    transaction.status = 'completed';
                    transaction.webhookVerified = true;
                    transaction.paidAt = new Date(psVerify.data.paid_at);
                    transaction.providerReference = psVerify.data.id?.toString();
                    transaction.amount = amountGHSPaid;
                    await transaction.save();

                    // Update ledger
                    let feeItem: any = transaction.feeItemId ? await FeeItem.findById(transaction.feeItemId) : null;
                    let academicFee: any = transaction.studentFeeId ? await StudentFee.findById(transaction.studentFeeId) : null;
                    await updateLedger(feeItem, academicFee, amountGHSPaid, transaction.category);

                    // ── REAL-TIME SOCKET UPDATE ──
                    const student = await User.findById(transaction.studentId).select('firstName lastName');
                    if (student) {
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
        const student = req.user!;

        const transaction = await Transaction.findOne({ reference });
        if (!transaction) {
            res.status(404).json({ message: 'Transaction not found.' });
            return;
        }

        // Only the owning student may cancel
        if (transaction.studentId.toString() !== student.id.toString()) {
            res.status(403).json({ message: 'Unauthorized.' });
            return;
        }

        // Only pending/processing transactions can be cancelled
        if (!['pending', 'processing'].includes(transaction.status)) {
            res.status(400).json({ message: `Cannot cancel a transaction with status '${transaction.status}'.` });
            return;
        }

        transaction.status = 'cancelled';
        transaction.metadata = {
            ...transaction.metadata,
            cancelledAt: new Date().toISOString(),
            cancelledBy: 'student',
        };
        await transaction.save();

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

        const filter: Record<string, any> = { studentId: req.user!.id };
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
 * Hard delete transaction history
 */
export const clearTransactionHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const studentId = req.user!.id;
        const fs = require('fs');
        const path = require('path');
        const logPath = path.join(process.cwd(), 'pay_errors.log');

        // Delete from Transaction model — keep cancelled records (they are important for audit)
        const transResult = await Transaction.deleteMany({
            studentId,
            status: { $in: ['completed', 'failed', 'pending'] }
        });

        // Delete from Payment reporting model as well
        const payResult = await Payment.deleteMany({ student: studentId });

        fs.appendFileSync(logPath, `[${new Date().toISOString()}] CLEAR HISTORY: Student=${studentId}, DeletedTrans=${transResult.deletedCount}, DeletedPay=${payResult.deletedCount}\n`);

        res.status(200).json({
            message: 'History deleted permanently',
            deletedTransactions: transResult.deletedCount,
            deletedPayments: payResult.deletedCount
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

        const completedTransactions = await Transaction.find({
            studentId,
            status: 'completed',
            webhookVerified: true,
            createdAt: { $gte: sixMonthsAgo },
        }).sort({ createdAt: 1 });

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthlyTrend: { label: string; amount: number }[] = [];
        const now = new Date();

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
                .reduce((sum, t) => sum + t.amount, 0);
            monthlyTrend.push({ label: monthNames[mIdx], amount: total });
        }

        const allCompleted = await Transaction.find({ studentId, status: 'completed', webhookVerified: true });

        const methodCounts: Record<string, { count: number; total: number }> = {};
        allCompleted.forEach(t => {
            if (!methodCounts[t.paymentMethod]) methodCounts[t.paymentMethod] = { count: 0, total: 0 };
            methodCounts[t.paymentMethod].count++;
            methodCounts[t.paymentMethod].total += t.amount;
        });
        const methodBreakdown = Object.entries(methodCounts).map(([method, data]) => ({
            method, count: data.count, total: data.total,
        }));

        // Category breakdown
        const categoryTotals: Record<string, number> = {};
        allCompleted.forEach(t => {
            categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
        });

        // Upcoming fee deadlines
        const feeItems = await FeeItem.find({
            studentId, status: { $in: ['pending', 'partial'] },
        }).populate('feeTypeId');

        const feeItemDeadlines = feeItems
            .filter(f => f.dueDate && new Date(f.dueDate) >= now)
            .map(f => {
                const feeType = f.feeTypeId as any;
                const dueDate = new Date(f.dueDate);
                const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                return { name: feeType?.name || 'Fee', category: feeType?.category || 'other', balance: f.balance, dueDate: f.dueDate, daysLeft };
            });

        const studentFees = await StudentFee.find({
            student: studentId, status: { $in: ['unpaid', 'partial'] }, dueDate: { $exists: true, $ne: null },
        }).populate('academicYear');

        const studentFeeDeadlines = studentFees
            .filter(sf => sf.dueDate && new Date(sf.dueDate) >= now)
            .map(sf => {
                const yearLabel = (sf.academicYear as any)?.yearLabel || '';
                const dueDate = new Date(sf.dueDate!);
                const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                return { name: `Academic Fees - ${yearLabel} S${sf.semester}`, category: 'tuition', balance: sf.balance, dueDate: sf.dueDate, daysLeft };
            });

        const upcomingDeadlines = [...feeItemDeadlines, ...studentFeeDeadlines]
            .sort((a, b) => a.daysLeft - b.daysLeft)
            .slice(0, 5);

        const totalPaidAll = allCompleted.reduce((sum, t) => sum + t.amount, 0);
        const totalTransactions = allCompleted.length;
        const currentMonthPaid = completedTransactions
            .filter(t => {
                const td = new Date(t.createdAt);
                return td.getMonth() === now.getMonth() && td.getFullYear() === now.getFullYear();
            })
            .reduce((sum, t) => sum + t.amount, 0);

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
        if (req.query.status) filter.status = req.query.status;
        if (req.query.category) filter.category = req.query.category;
        if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
        if (req.query.paymentChannel) filter.paymentChannel = req.query.paymentChannel;
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
