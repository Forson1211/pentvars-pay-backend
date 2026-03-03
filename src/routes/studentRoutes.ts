import { Router } from 'express';
import {
    getStudentDashboard,
    getStudentFees,
    getStudentPayments,
    makePayment,
    getPaymentReceipt,
} from '../controllers/studentDashboardController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// All student routes require authentication + student role
router.use(authenticate);

// Student Dashboard (triggers server-side fee calculation)
router.get('/dashboard', authorize('student'), getStudentDashboard);

// Student Fees
router.get('/fees', authorize('student'), getStudentFees);

// Student Payment History
router.get('/payments', authorize('student'), getStudentPayments);

// Make Payment
router.post('/pay', authorize('student'), makePayment);

// Payment Receipt
router.get('/payment-receipt/:paymentId', getPaymentReceipt);

export default router;
