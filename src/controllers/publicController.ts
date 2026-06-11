import { Request, Response, NextFunction } from 'express';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';

/**
 * GET /api/public/faculties
 * Public: Get all active faculties
 */
export const getPublicFaculties = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const faculties = await Faculty.find({ isActive: true }).sort({ name: 1 });
        res.json(faculties);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/public/programmes?facultyId=XXX
 * Public: Get active programmes filtered by faculty
 */
export const getPublicProgrammes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { facultyId } = req.query;
        const filter: any = { isActive: true };
        if (facultyId) {
            filter.faculty = facultyId;
        }
        const programmes = await Programme.find(filter)
            .populate('faculty', 'name code')
            .sort({ programmeName: 1 });
        res.json(programmes);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/public/fee-preview
 * Public: Preview fees before registration
 * Body: { facultyId, programmeId, studentType, level }
 */
export const getFeePreview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { facultyId, programmeId, studentType, level } = req.body;

        if (!facultyId || !programmeId || !studentType || !level) {
            res.status(400).json({ message: 'facultyId, programmeId, studentType, and level are required.' });
            return;
        }

        // Validate programme belongs to faculty
        const programme = await Programme.findById(programmeId).populate('faculty');
        if (!programme) {
            res.status(404).json({ message: 'Programme not found.' });
            return;
        }
        if (programme.faculty.toString() !== facultyId && (programme.faculty as any)._id?.toString() !== facultyId) {
            res.status(400).json({ message: 'Programme does not belong to the selected faculty.' });
            return;
        }

        // Get active academic year
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (!activeYear) {
            res.status(404).json({ message: 'No active academic year configured. Contact administration.' });
            return;
        }

        // Find matching FeeTemplate
        const template = await FeeTemplate.findOne({
            academicYear: activeYear._id,
            faculty: facultyId,
            programme: programmeId,
            studentType,
            level,
            isActive: true,
        })
            .populate('academicYear')
            .populate('faculty')
            .populate('programme');

        if (!template) {
            res.status(404).json({
                message: `No fee structure found for this combination. Please contact administration.`,
                details: {
                    academicYear: activeYear.yearLabel,
                    faculty: (programme.faculty as any).name || facultyId,
                    programme: programme.programmeName,
                    studentType,
                    level,
                }
            });
            return;
        }

        // Calculate — ALL server-side
        const tuition = template.tuitionPerSemester;
        const sem2Tuition = template.sem2TuitionPerSemester !== undefined && template.sem2TuitionPerSemester !== null
            ? template.sem2TuitionPerSemester
            : tuition;
        const academicUserFee = Math.round((template.academicUserFee || 0) * 100) / 100;
        const srcFee = Math.round((template.srcFee || 0) * 100) / 100;
        const practicalFee = template.practicalFee || 0;
        const cipsFee = template.cipsFee || 0;

        const semesterTotal = Math.round((tuition + academicUserFee + srcFee + practicalFee + cipsFee) * 100) / 100;
        const annualTotal = Math.round((tuition + sem2Tuition + (template.academicUserFee || 0) * 2 + (template.srcFee || 0) * 2 + (practicalFee * 2) + (cipsFee * 2)) * 100) / 100;

        res.json({
            academicYear: activeYear.toJSON(),
            faculty: template.faculty,
            programme: template.programme,
            studentType: template.studentType,
            level: template.level,
            breakdown: {
                tuition,
                academicUserFee,
                srcFee,
                practicalFee,
                cipsFee,
            },
            semesterTotal,
            annualTotal,
            installmentAllowed: template.installmentAllowed,
            maxInstallments: template.maxInstallments,
        });
    } catch (error) {
        next(error);
    }
};
