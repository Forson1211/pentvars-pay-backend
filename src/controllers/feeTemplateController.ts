import { Request, Response, NextFunction } from 'express';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';
import { StudentFee } from '../models/StudentFee';
import { FeeCalculationService } from '../services/feeCalculationService';
import { emitFeeUpdate } from '../services/socketService';

/**
 * POST /api/admin/fee-template
 * Admin: Create a new fee template
 */
export const createFeeTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const {
            academicYear, studentType, faculty, programme, level,
            tuitionPerSemester, sem2TuitionPerSemester, academicUserFee, srcFee,
            practicalFee, cipsFee, latePenalty,
            scholarshipDiscount, installmentAllowed, maxInstallments,
            dueDate,
        } = req.body;

        // Validate required fields
        if (!academicYear || !studentType || !faculty || !programme || !level || tuitionPerSemester === undefined) {
            res.status(400).json({
                message: 'academicYear, studentType, faculty, programme, level, and tuitionPerSemester are required.',
            });
            return;
        }

        // Check for duplicate template
        const existing = await FeeTemplate.findOne({
            academicYear, studentType, faculty, programme, level,
        });
        if (existing) {
            res.status(400).json({
                message: 'A fee template for this combination already exists.',
            });
            return;
        }

        const template = await FeeTemplate.create({
            academicYear,
            studentType,
            faculty,
            programme,
            level,
            tuitionPerSemester,
            sem2TuitionPerSemester: sem2TuitionPerSemester !== undefined && sem2TuitionPerSemester !== null ? Number(sem2TuitionPerSemester) : undefined,
            academicUserFee: academicUserFee || 0,
            srcFee: srcFee || 0,
            practicalFee: practicalFee || 0,
            cipsFee: cipsFee || 0,
            latePenalty: latePenalty || 0,
            scholarshipDiscount: scholarshipDiscount || 0,
            installmentAllowed: installmentAllowed !== false,
            maxInstallments: maxInstallments || 3,
            dueDate: dueDate ? new Date(dueDate) : undefined,
            createdBy: req.user!._id,
        });

        const populated = await FeeTemplate.findById(template._id)
            .populate('academicYear')
            .populate('faculty')
            .populate('programme');

        res.status(201).json(populated!.toJSON());

        // 🔴 Notify all students to refresh their dashboard
        emitFeeUpdate({ type: 'fee_template', action: 'created' });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/fee-templates
 * Admin: Get all fee templates (with filters)
 */
export const getAllFeeTemplates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, studentType, faculty, programme, level, isActive } = req.query;
        const filter: Record<string, any> = {};

        if (academicYear) filter.academicYear = academicYear;
        if (studentType) filter.studentType = studentType;
        if (faculty) filter.faculty = faculty;
        if (programme) filter.programme = programme;
        if (level) filter.level = level;
        if (isActive !== undefined) filter.isActive = isActive === 'true';

        const templates = await FeeTemplate.find(filter)
            .populate('academicYear')
            .populate('faculty')
            .populate('programme')
            .populate('createdBy', 'firstName lastName')
            .sort({ createdAt: -1 });

        res.json(templates);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/fee-template/:id
 * Admin: Get a single fee template
 */
export const getFeeTemplateById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const template = await FeeTemplate.findById(req.params.id)
            .populate('academicYear')
            .populate('faculty')
            .populate('programme')
            .populate('createdBy', 'firstName lastName');

        if (!template) {
            res.status(404).json({ message: 'Fee template not found.' });
            return;
        }

        // Also calculate the semester totals for preview
        const semester1 = FeeCalculationService.calculateSemesterBreakdown(template, 1, false);
        const semester2 = FeeCalculationService.calculateSemesterBreakdown(template, 2, false);

        res.json({
            ...template.toJSON(),
            preview: {
                semester1Total: semester1.totalFee,
                semester2Total: semester2.totalFee,
                annualTotal: semester1.totalFee + semester2.totalFee,
                breakdown: semester1.breakdown,
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/fee-template/:id
 * Admin: Update a fee template + recalculate affected StudentFees
 */
export const updateFeeTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const allowedFields = [
            'tuitionPerSemester', 'sem2TuitionPerSemester', 'academicUserFee', 'srcFee', 'practicalFee',
            'cipsFee', 'latePenalty', 'scholarshipDiscount',
            'installmentAllowed', 'maxInstallments', 'dueDate', 'isActive',
        ];

        const updates: Record<string, any> = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        const template = await FeeTemplate.findByIdAndUpdate(
            id,
            { $set: updates },
            { new: true, runValidators: true }
        ).populate('academicYear').populate('faculty').populate('programme');

        if (!template) {
            res.status(404).json({ message: 'Fee template not found.' });
            return;
        }

        // CRITICAL: Recalculate all StudentFee records that use this template
        const affectedFees = await StudentFee.find({ feeTemplate: template._id });
        let recalculated = 0;

        for (const fee of affectedFees) {
            const updatedFee = await FeeCalculationService.recalculateStudentFee(fee._id as any, template);
            // If dueDate was updated on the template, propagate to StudentFee
            if (updatedFee && updates.dueDate !== undefined) {
                updatedFee.dueDate = updates.dueDate ? new Date(updates.dueDate) : undefined;
                await updatedFee.save();
            }
            recalculated++;
        }

        res.json({
            message: `Fee template updated. ${recalculated} student fee records recalculated.`,
            template: template.toJSON(),
            recalculatedCount: recalculated,
        });

        // 🔴 Notify all students to refresh their dashboard
        emitFeeUpdate({ type: 'fee_template', action: 'updated' });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/fee-template/:id
 * Admin: Delete a fee template
 */
export const deleteFeeTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const template = await FeeTemplate.findById(id);
        if (!template) {
            res.status(404).json({ message: 'Fee template not found.' });
            return;
        }

        // Check if any student fees reference this template with payments made
        const feesWithPayments = await StudentFee.countDocuments({
            feeTemplate: id,
            amountPaid: { $gt: 0 },
        });

        if (feesWithPayments > 0) {
            res.status(400).json({
                message: `Cannot delete: ${feesWithPayments} student fee records have payments against this template. Deactivate instead.`,
            });
            return;
        }

        // Delete unpaid student fees referencing this template
        await StudentFee.deleteMany({ feeTemplate: id, amountPaid: 0 });

        // Delete the template
        await FeeTemplate.findByIdAndDelete(id);

        res.json({ message: 'Fee template and unpaid student fees deleted.' });

        // 🔴 Notify all students to refresh
        emitFeeUpdate({ type: 'fee_template', action: 'deleted' });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/fee-template/:id/clone
 * Admin: Clone a fee template for a new academic year
 */
export const cloneFeeTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { targetAcademicYear } = req.body;

        if (!targetAcademicYear) {
            res.status(400).json({ message: 'Target academic year is required.' });
            return;
        }

        // Verify target academic year exists
        const targetYear = await AcademicYear.findById(targetAcademicYear);
        if (!targetYear) {
            res.status(404).json({ message: 'Target academic year not found.' });
            return;
        }

        const source = await FeeTemplate.findById(id);
        if (!source) {
            res.status(404).json({ message: 'Source fee template not found.' });
            return;
        }

        // Check for duplicate
        const existing = await FeeTemplate.findOne({
            academicYear: targetAcademicYear,
            studentType: source.studentType,
            programme: source.programme,
            level: source.level,
        });

        if (existing) {
            res.status(400).json({
                message: 'A fee template for this combination already exists in the target academic year.',
            });
            return;
        }

        const cloned = await FeeTemplate.create({
            academicYear: targetAcademicYear,
            studentType: source.studentType,
            faculty: source.faculty,
            programme: source.programme,
            level: source.level,
            tuitionPerSemester: source.tuitionPerSemester,
            sem2TuitionPerSemester: source.sem2TuitionPerSemester,
            academicUserFee: source.academicUserFee,
            srcFee: source.srcFee,
            practicalFee: source.practicalFee,
            cipsFee: source.cipsFee,
            latePenalty: source.latePenalty,
            scholarshipDiscount: source.scholarshipDiscount,
            installmentAllowed: source.installmentAllowed,
            maxInstallments: source.maxInstallments,
            dueDate: source.dueDate,
            createdBy: req.user!._id,
        });

        const populated = await FeeTemplate.findById(cloned._id)
            .populate('academicYear')
            .populate('faculty')
            .populate('programme');

        res.status(201).json({
            message: `Fee template cloned to academic year "${targetYear.yearLabel}".`,
            template: populated!.toJSON(),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/fee-template/bulk-clone
 * Admin: Clone ALL templates from one academic year to another
 */
export const bulkCloneFeeTemplates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { sourceAcademicYear, targetAcademicYear } = req.body;

        if (!sourceAcademicYear || !targetAcademicYear) {
            res.status(400).json({ message: 'Both source and target academic years are required.' });
            return;
        }

        const targetYear = await AcademicYear.findById(targetAcademicYear);
        if (!targetYear) {
            res.status(404).json({ message: 'Target academic year not found.' });
            return;
        }

        const sourceTemplates = await FeeTemplate.find({ academicYear: sourceAcademicYear, isActive: true });

        if (sourceTemplates.length === 0) {
            res.status(404).json({ message: 'No active fee templates found for the source academic year.' });
            return;
        }

        let cloned = 0;
        let skipped = 0;

        for (const source of sourceTemplates) {
            const existing = await FeeTemplate.findOne({
                academicYear: targetAcademicYear,
                studentType: source.studentType,
                programme: source.programme,
                level: source.level,
            });

            if (existing) {
                skipped++;
                continue;
            }

            await FeeTemplate.create({
                academicYear: targetAcademicYear,
                studentType: source.studentType,
                faculty: source.faculty,
                programme: source.programme,
                level: source.level,
                tuitionPerSemester: source.tuitionPerSemester,
                sem2TuitionPerSemester: source.sem2TuitionPerSemester,
                academicUserFee: source.academicUserFee,
                srcFee: source.srcFee,
                practicalFee: source.practicalFee,
                cipsFee: source.cipsFee,
                latePenalty: source.latePenalty,
                scholarshipDiscount: source.scholarshipDiscount,
                installmentAllowed: source.installmentAllowed,
                maxInstallments: source.maxInstallments,
                dueDate: source.dueDate,
                createdBy: req.user!._id,
            });

            cloned++;
        }

        res.status(201).json({
            message: `Bulk clone complete: ${cloned} cloned, ${skipped} skipped (already exist).`,
            cloned,
            skipped,
            targetAcademicYear: targetYear.yearLabel,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/fee-template/bulk-deadline
 * Admin: Update deadline for ALL templates matching filters (e.g. academicYear, studentType)
 */
export const updateBulkFeeTemplateDeadline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, studentType, dueDate } = req.body;

        if (!academicYear || !dueDate) {
            res.status(400).json({ message: 'academicYear and dueDate are required.' });
            return;
        }

        const filter: Record<string, any> = { academicYear };
        if (studentType && studentType !== 'all') {
            filter.studentType = studentType;
        }

        // 1. Find all matching templates
        const templates = await FeeTemplate.find(filter);
        if (templates.length === 0) {
            res.status(404).json({ message: 'No fee templates found for the specified filters.' });
            return;
        }

        const templateIds = templates.map(t => t._id);

        // 2. Update the FeeTemplate records
        await FeeTemplate.updateMany(filter, { $set: { dueDate: new Date(dueDate) } });

        // 3. Propagate the dueDate update to all affected StudentFee records
        const result = await StudentFee.updateMany(
            { feeTemplate: { $in: templateIds } },
            { $set: { dueDate: new Date(dueDate) } }
        );

        res.json({
            message: `General deadline updated for ${templates.length} templates and ${result.modifiedCount} student fee records.`,
            dueDate: new Date(dueDate),
            count: templates.length,
            recalculatedCount: result.modifiedCount
        });

        // 🔴 Notify all students to refresh
        try {
            emitFeeUpdate({ type: 'fee_template', action: 'updated' });
        } catch (_) { /* silent */ }
    } catch (error) {
        next(error);
    }
};

