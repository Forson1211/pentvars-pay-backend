import { Router } from 'express';
import {
    createAcademicYear,
    getAllAcademicYears,
    getActiveAcademicYear,
    activateAcademicYear,
    updateAcademicYear,
    deleteAcademicYear,
} from '../controllers/academicYearController';
import {
    createFaculty,
    getAllFaculties,
    updateFaculty,
    deleteFaculty,
} from '../controllers/facultyController';
import {
    createProgramme,
    getAllProgrammes,
    getProgrammeById,
    updateProgramme,
    deleteProgramme,
    getDistinctFaculties,
} from '../controllers/programmeController';
import {
    createFeeTemplate,
    getAllFeeTemplates,
    getFeeTemplateById,
    updateFeeTemplate,
    deleteFeeTemplate,
    cloneFeeTemplate,
    bulkCloneFeeTemplates,
} from '../controllers/feeTemplateController';
import {
    getRevenueReport,
    getOutstandingReport,
    exportOutstandingCSV,
    getAdminDashboardSummary,
    getAllStudentsWithBalance,
    getStudentDetails,
    getStudentCountByGroups,
    getPaymentList,
} from '../controllers/reportController';
import { getAdminHierarchy, createStaff, getAdvancedStats, impersonateUser, updateStaff, deleteStaff, toggleHostelStatus } from '../controllers/adminController';
import { previewPromotion, promoteStudents } from '../controllers/promotionController';
import { authenticate, authorize } from '../middleware/auth';
import { Request, Response, NextFunction } from 'express';
import { ReconciliationService } from '../services/reconciliationService';

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, authorize('admin'));

// ──── Academic Year Management ────
router.post('/academic-year', createAcademicYear);
router.get('/academic-years', getAllAcademicYears);
router.get('/academic-year/active', getActiveAcademicYear);
router.put('/academic-year/:id/activate', activateAcademicYear);
router.put('/academic-year/:id', updateAcademicYear);
router.delete('/academic-year/:id', deleteAcademicYear);

// ──── Faculty Management ────
router.post('/faculty', createFaculty);
router.get('/faculties', getAllFaculties);
router.put('/faculty/:id', updateFaculty);
router.delete('/faculty/:id', deleteFaculty);

// ──── Programme Management ────
router.post('/programme', createProgramme);
router.get('/programmes', getAllProgrammes);
router.get('/programmes/faculties', getDistinctFaculties);
router.get('/programme/:id', getProgrammeById);
router.put('/programme/:id', updateProgramme);
router.delete('/programme/:id', deleteProgramme);

// ──── Fee Template Management ────
router.post('/fee-template', createFeeTemplate);
router.get('/fee-templates', getAllFeeTemplates);
router.get('/fee-template/:id', getFeeTemplateById);
router.put('/fee-template/:id', updateFeeTemplate);
router.delete('/fee-template/:id', deleteFeeTemplate);
router.post('/fee-template/:id/clone', cloneFeeTemplate);
router.post('/fee-template/bulk-clone', bulkCloneFeeTemplates);

// ──── Reports ────
router.get('/reports/revenue', getRevenueReport);
router.get('/reports/outstanding', getOutstandingReport);
router.get('/reports/export-csv', exportOutstandingCSV);
router.get('/reports/dashboard-summary', getAdminDashboardSummary);
router.get('/students/count', getStudentCountByGroups);
router.get('/payments', getPaymentList);

// ──── Student Management ────
router.get('/students', getAllStudentsWithBalance);
router.get('/students/:id', getStudentDetails);
router.get('/promotion-preview', previewPromotion);
router.post('/promote-students', promoteStudents);

// ──── Staff Management ────
router.get('/hierarchy', getAdminHierarchy);
router.post('/create-staff', createStaff);
router.post('/impersonate', impersonateUser);
router.put('/staff/:id', updateStaff);
router.delete('/staff/:id', deleteStaff);
router.get('/stats/advanced', getAdvancedStats);

// ──── Student Hostel Toggle ────
router.put('/students/:id/hostel-status', toggleHostelStatus);

// ──── Reconciliation ────
router.post('/reconcile', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const daysBack = parseInt(req.query.days as string) || 1;
        const report = await ReconciliationService.runReconciliation(daysBack);
        res.json({ message: 'Reconciliation complete', report });
    } catch (error) {
        next(error);
    }
});

export default router;

