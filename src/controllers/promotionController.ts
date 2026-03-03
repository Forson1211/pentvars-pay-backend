import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { FeeCalculationService } from '../services/feeCalculationService';
import { Programme } from '../models/Programme';
import { Types } from 'mongoose';

/**
 * GET /api/admin/promotion-preview
 * Previews the promotion results (how many move, how many block, how many graduate)
 */
export const previewPromotion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        if (!activeYear) {
            res.status(400).json({ message: 'No active academic year found for promotion' });
            return;
        }

        const students = await User.find({ role: 'student', status: 'active' }).populate('programmeRef');

        const preview = {
            movingTo200: 0,
            movingTo300: 0,
            movingTo400: 0,
            graduating: 0,
            blocked: 0,
            blockedDetails: [] as any[],
        };

        for (const student of students) {
            const currentLevel = student.currentLevel || parseInt(student.level || '100');
            const graduationLevel = student.graduationLevel || 400;

            if (currentLevel >= graduationLevel) {
                preview.graduating++;
                continue;
            }

            const nextLevel = currentLevel + 100;
            const studentType = FeeCalculationService.determineStudentType(student);

            let programmeId: Types.ObjectId | null = null;
            if (student.programmeRef) {
                programmeId = (student.programmeRef as any)._id as Types.ObjectId;
            } else {
                programmeId = await FeeCalculationService.resolveProgrammeId(student);
            }

            if (!programmeId) {
                preview.blocked++;
                preview.blockedDetails.push({ studentId: student.studentId, name: `${student.firstName} ${student.lastName}`, reason: 'No valid programme assigned' });
                continue;
            }

            // Verify FeeTemplate exists for next level
            const template = await FeeCalculationService.findMatchingTemplate(
                activeYear._id as Types.ObjectId,
                studentType,
                programmeId,
                nextLevel.toString()
            );

            if (!template) {
                preview.blocked++;
                preview.blockedDetails.push({
                    studentId: student.studentId,
                    name: `${student.firstName} ${student.lastName}`,
                    reason: `No FeeTemplate found for ${studentType}, Level ${nextLevel}`
                });
                continue;
            }

            // valid promotion path
            if (nextLevel === 200) preview.movingTo200++;
            if (nextLevel === 300) preview.movingTo300++;
            if (nextLevel === 400) preview.movingTo400++;
        }

        res.status(200).json({
            academicYear: activeYear.yearLabel,
            totalStudents: students.length,
            preview,
        });

    } catch (error) {
        next(error);
    }
}

/**
 * POST /api/admin/promote-students
 * Runs the final promotion process
 */
export const promoteStudents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        if (!activeYear) {
            res.status(400).json({ message: 'No active academic year found for promotion' });
            return;
        }

        const students = await User.find({ role: 'student', status: 'active' }).populate('programmeRef');

        let promotedCount = 0;
        let graduatedCount = 0;
        let blockedCount = 0;

        for (const student of students) {
            const currentLevel = student.currentLevel || parseInt(student.level || '100');
            const graduationLevel = student.graduationLevel || 400;

            if (currentLevel >= graduationLevel) {
                // Graduate student
                student.status = 'graduated';
                student.level = graduationLevel.toString();
                student.currentLevel = graduationLevel;
                await student.save();
                graduatedCount++;
                continue;
            }

            const nextLevel = currentLevel + 100;
            const studentType = FeeCalculationService.determineStudentType(student);

            let programmeId: Types.ObjectId | null = null;
            if (student.programmeRef) {
                programmeId = (student.programmeRef as any)._id as Types.ObjectId;
            } else {
                programmeId = await FeeCalculationService.resolveProgrammeId(student);
            }

            if (!programmeId) {
                blockedCount++;
                continue;
            }

            const template = await FeeCalculationService.findMatchingTemplate(
                activeYear._id as Types.ObjectId,
                studentType,
                programmeId,
                nextLevel.toString()
            );

            if (!template) {
                blockedCount++;
                continue;
            }

            // Perform promotion
            student.currentLevel = nextLevel;
            student.level = nextLevel.toString();
            student.currentAcademicYear = activeYear._id;

            // Mark graduated if they reached graduation level early? We'll leave it 'active' here and graduate next time.
            if (nextLevel === graduationLevel) {
                // Wait! If they just hit 400, they are active at 400. Next year they graduate.
                student.status = 'active';
            }

            await student.save();

            // Optionally pre-generate sem 1 and 2 records immediately, or rely on active student login flow.
            // Requirement said "Generate new fees". So we do it immediately for semester 1.
            try {
                await FeeCalculationService.getOrCreateStudentFee(student, 1);
            } catch (err) {
                console.error(`Failed to generate fee for promoted student ${student.studentId}:`, err);
            }

            promotedCount++;
        }

        res.status(200).json({
            message: 'Promotion process completed successfully.',
            academicYear: activeYear.yearLabel,
            results: {
                promoted: promotedCount,
                graduated: graduatedCount,
                blocked: blockedCount,
            }
        });

    } catch (error) {
        next(error);
    }
}
