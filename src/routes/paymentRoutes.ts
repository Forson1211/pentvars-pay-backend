import { Router } from 'express';
import {
    initiatePayment,
    verifyPayment,
    getTransactionHistory,
    getTransactionById,
    generateReceipt,
    getPaymentStats,
    getPaymentInsights,
    getStudentPaymentInsights,
    getAllTransactions,
    exportReport,
    handleWebhook,
    getDailySummary,
    getAuditLogs,
    clearTransactionHistory,
    debugMyPayments,
} from '../controllers/paymentController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// ─── WEBHOOK (no auth — Paystack calls this directly) ────────────────────────
// IMPORTANT: Must be registered BEFORE express.json() middleware is applied
// The rawBody middleware must capture raw bytes for HMAC signature verification.
// See server.ts — the /api/payments/webhook route must exclude JSON parsing.
router.post('/webhook', handleWebhook);

// ─── Authenticated routes ────────────────────────────────────────────────────
router.use(authenticate);

// Student routes
router.post('/initiate', initiatePayment);
router.get('/history', getTransactionHistory);
router.delete('/history/clear', clearTransactionHistory);
router.get('/debug/my-data', debugMyPayments);
router.get('/receipt/:transactionId', generateReceipt);
router.get('/student-insights', getStudentPaymentInsights);
router.get('/verify/:reference', verifyPayment);

// Admin-only routes
router.get('/stats', authorize('admin'), getPaymentStats);
router.get('/insights', authorize('admin'), getPaymentInsights);
router.get('/all', authorize('admin'), getAllTransactions);
router.get('/export', authorize('admin'), exportReport);
router.get('/daily-summary', authorize('admin'), getDailySummary);
router.get('/audit-logs', authorize('admin'), getAuditLogs);

// Generic get by ID (must be last due to param matching)
router.get('/:transactionId', getTransactionById);

export default router;
