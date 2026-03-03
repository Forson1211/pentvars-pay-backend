import { Router } from 'express';
import {
    getStudentFees,
    getFeeById,
    getFeeSummary,
    getAllFeeTypes,
    createFeeType,
    updateFeeType,
    deleteFeeType,
    assignFeeToStudent,
    bulkAssignFees,
} from '../controllers/feeController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// All fee routes require authentication
router.use(authenticate);

// Student routes
router.get('/student', getStudentFees);
router.get('/summary', getFeeSummary);
router.get('/:feeId', getFeeById);

// Admin-only routes
// Public-ish (authenticated) routes for fee information
router.get('/types/all', getAllFeeTypes);
router.post('/types', authorize('admin'), createFeeType);
router.put('/types/:feeTypeId', authorize('admin'), updateFeeType);
router.delete('/types/:feeTypeId', authorize('admin'), deleteFeeType);
router.post('/assign', authorize('admin'), assignFeeToStudent);
router.post('/bulk-assign', authorize('admin'), bulkAssignFees);

export default router;
