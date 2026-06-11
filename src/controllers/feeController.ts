import { Request, Response, NextFunction } from 'express';
import { FeeType } from '../models/FeeType';
import { FeeItem } from '../models/FeeItem';
import { User } from '../models/User';
import { FeeCalculationService } from '../services/feeCalculationService';
import { emitFeeUpdate } from '../services/socketService';

/**
 * GET /api/fees/student
 * Get all fee items for the currently authenticated student
 */
export const getStudentFees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, semester } = req.query;

        // Ensure global fees (Hostel, Exams) are assigned to the student
        await FeeCalculationService.assignApplicableGlobalFees(req.user! as any);

        const filter: Record<string, any> = { studentId: req.user!.id };

        if (academicYear) filter.academicYear = academicYear;
        if (semester) filter.semester = semester;

        const feeItems = await FeeItem.find(filter)
            .populate('feeTypeId')
            .sort({ createdAt: -1 });

        // Transform and filter only active fee types
        const result = feeItems
            .map((item) => {
                const json = item.toJSON();
                const feeType = json.feeTypeId as any;
                const tid = feeType?._id || item.feeTypeId;

                return {
                    ...json,
                    feeType: feeType,
                    feeTypeId: tid ? tid.toString() : null,
                };
            })
            .filter((item) => (item.feeType as any)?.isActive !== false);

        res.json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/fees/:feeId
 * Get a specific fee item by ID
 */
export const getFeeById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const feeItem = await FeeItem.findById(req.params.feeId).populate('feeTypeId');

        if (!feeItem || !(feeItem.feeTypeId as any)?.isActive) {
            res.status(404).json({ message: 'Fee item not found or inactive.' });
            return;
        }

        const json = feeItem.toJSON();
        res.json({
            ...json,
            feeType: json.feeTypeId,
            feeTypeId: (feeItem.feeTypeId as any)._id || feeItem.feeTypeId,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/fees/summary
 * Get fee summary for the authenticated student
 */
export const getFeeSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const feeItems = await FeeItem.find({ studentId: req.user!.id }).populate('feeTypeId');

        // Filter only active fees for the summary
        const activeFeeItems = feeItems.filter(f => (f.feeTypeId as any)?.isActive);

        const totalFees = activeFeeItems.reduce((acc, f) => acc + f.totalAmount, 0);
        const totalPaid = activeFeeItems.reduce((acc, f) => acc + f.amountPaid, 0);
        const totalBalance = activeFeeItems.reduce((acc, f) => acc + f.balance, 0);

        const categories = ['tuition', 'hostel', 'src_dues', 'exam', 'resit', 'supplementary', 'other'];
        const categoryLabels: Record<string, string> = {
            tuition: 'Tuition Fees',
            hostel: 'Accommodation',
            src_dues: 'SRC Dues',
            exam: 'Regular Exams',
            resit: 'Resit Exams',
            supplementary: 'Supplementary Exams',
            other: 'Other Fees',
        };

        const breakdowns = categories
            .map((cat) => {
                const items = activeFeeItems.filter((f) => {
                    const feeType = f.feeTypeId as any;
                    return feeType?.category === cat;
                });

                const catTotal = items.reduce((acc, f) => acc + f.totalAmount, 0);
                const catPaid = items.reduce((acc, f) => acc + f.amountPaid, 0);
                const catBalance = items.reduce((acc, f) => acc + f.balance, 0);

                const transformedItems = items.map((item) => {
                    const json = item.toJSON();
                    const tid = (item.feeTypeId as any)._id || item.feeTypeId;
                    return {
                        ...json,
                        feeType: json.feeTypeId,
                        feeTypeId: tid ? tid.toString() : null,
                    };
                });

                return {
                    category: cat,
                    label: categoryLabels[cat] || 'Other Fees',
                    totalAmount: catTotal,
                    amountPaid: catPaid,
                    balance: catBalance,
                    status: catBalance === 0 ? 'paid' : catPaid > 0 ? 'partial' : 'pending',
                    items: transformedItems,
                };
            })
            .filter((b) => b.totalAmount > 0);

        res.json({
            totalFees,
            totalPaid,
            totalBalance,
            breakdowns,
        });
    } catch (error) {
        next(error);
    }
};

// ──────────────────── ADMIN ROUTES ────────────────────

/**
 * GET /api/fees/types
 * Admin: Get all fee types
 */
export const getAllFeeTypes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, semester, isActive } = req.query;
        const filter: Record<string, any> = {};

        if (academicYear) filter.academicYear = academicYear;
        if (semester) filter.semester = semester;
        if (isActive !== undefined) filter.isActive = isActive === 'true';

        const feeTypes = await FeeType.find(filter).sort({ createdAt: -1 });
        res.json(feeTypes);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/fees/types
 * Admin: Create a new fee type
 */
export const createFeeType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const feeType = await FeeType.create(req.body);

        // Auto-assign to matching students if active
        if (feeType.isActive) {
            const studentFilter: any = { role: 'student' };
            if (feeType.applicableStream !== 'all') {
                studentFilter.stream = feeType.applicableStream;
            }
            if (feeType.applicableNationality !== 'all') {
                studentFilter.nationality = feeType.applicableNationality;
            }

            const students = await User.find(studentFilter);
            await Promise.all(
                students.map(async (student) => {
                    await FeeItem.create({
                        feeTypeId: feeType._id,
                        studentId: student._id,
                        totalAmount: feeType.amount,
                        amountPaid: 0,
                        balance: feeType.amount,
                        status: 'pending',
                        dueDate: feeType.dueDate,
                        academicYear: feeType.academicYear,
                        semester: feeType.semester,
                    });
                })
            );
        }

        res.status(201).json(feeType.toJSON());

        // 🔴 Notify all students in real-time
        emitFeeUpdate({ type: 'fee_type', action: 'created' });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/fees/types/:feeTypeId
 * Admin: Update a fee type
 */
export const updateFeeType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const oldFeeType = await FeeType.findById(req.params.feeTypeId);
        if (!oldFeeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        const feeType = await FeeType.findByIdAndUpdate(
            req.params.feeTypeId,
            { $set: req.body },
            { new: true, runValidators: true }
        );

        if (!feeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        // --- PROPAGATE CHANGES TO STUDENTS ---

        // 1. Sync basic info for all associated items
        const syncUpdates: any = {};
        if (req.body.dueDate) syncUpdates.dueDate = req.body.dueDate;
        if (req.body.academicYear) syncUpdates.academicYear = req.body.academicYear;
        if (req.body.semester) syncUpdates.semester = req.body.semester;

        if (Object.keys(syncUpdates).length > 0) {
            await FeeItem.updateMany({ feeTypeId: feeType._id }, { $set: syncUpdates });
        }

        // 2. Sync amount changes
        if (req.body.amount !== undefined && req.body.amount !== oldFeeType.amount) {
            const items = await FeeItem.find({ feeTypeId: feeType._id });
            await Promise.all(items.map(async (item) => {
                const newBalance = req.body.amount - item.amountPaid;
                let status = 'pending';
                if (newBalance <= 0) status = 'paid';
                else if (item.amountPaid > 0) status = 'partial';

                await FeeItem.findByIdAndUpdate(item._id, {
                    $set: {
                        totalAmount: req.body.amount,
                        balance: Math.max(0, newBalance),
                        status: status
                    }
                });
            }));
        }

        // 3. Handle Eligibility changes (Stream/Nationality)
        const eligibilityChanged =
            (req.body.applicableStream && req.body.applicableStream !== oldFeeType.applicableStream) ||
            (req.body.applicableNationality && req.body.applicableNationality !== oldFeeType.applicableNationality);

        if (eligibilityChanged || (req.body.isActive === true && !oldFeeType.isActive)) {
            // Find all matching students
            const studentFilter: any = { role: 'student' };
            if (feeType.applicableStream !== 'all') studentFilter.stream = feeType.applicableStream;
            if (feeType.applicableNationality !== 'all') studentFilter.nationality = feeType.applicableNationality;

            const matchingStudents = await User.find(studentFilter);
            const matchingIds = matchingStudents.map(s => s._id.toString());

            // Add fee to new matching students
            await Promise.all(matchingStudents.map(async (student) => {
                const exists = await FeeItem.findOne({ studentId: student._id, feeTypeId: feeType._id });
                if (!exists && feeType.isActive) {
                    await FeeItem.create({
                        feeTypeId: feeType._id,
                        studentId: student._id,
                        totalAmount: feeType.amount,
                        amountPaid: 0,
                        balance: feeType.amount,
                        status: 'pending',
                        dueDate: feeType.dueDate,
                        academicYear: feeType.academicYear,
                        semester: feeType.semester,
                    });
                }
            }));

            // Optional: Remove fee from students who no longer match and haven't paid anything
            if (eligibilityChanged) {
                await FeeItem.deleteMany({
                    feeTypeId: feeType._id,
                    amountPaid: 0,
                    studentId: { $nin: matchingIds }
                });
            }
        }

        res.json(feeType.toJSON());

        // 🔴 Notify all students in real-time
        emitFeeUpdate({ type: 'fee_type', action: 'updated' });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/fees/types/:feeTypeId
 * Admin: Delete a fee type
 */
export const deleteFeeType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const feeType = await FeeType.findById(req.params.feeTypeId);
        if (!feeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        // Delete associated fee items that HAVE NO PAYMENTS
        await FeeItem.deleteMany({ feeTypeId: feeType._id, amountPaid: 0 });

        // If some items remain (because of payments), they will be orphaned but history is preserved
        await FeeType.findByIdAndDelete(req.params.feeTypeId);

        res.json({ message: 'Fee type deleted. Unpaid assignments removed.' });

        // 🔴 Notify all students in real-time
        emitFeeUpdate({ type: 'fee_type', action: 'deleted' });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/fees/assign
 * Admin: Assign a fee to a student
 */
export const assignFeeToStudent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { studentId, feeTypeId, academicYear, semester } = req.body;

        // Validate student exists
        const student = await User.findById(studentId);
        if (!student || student.role !== 'student') {
            res.status(404).json({ message: 'Student not found.' });
            return;
        }

        // Validate fee type exists
        const feeType = await FeeType.findById(feeTypeId);
        if (!feeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        const feeItem = await FeeItem.create({
            feeTypeId,
            studentId,
            totalAmount: feeType.amount,
            amountPaid: 0,
            balance: feeType.amount,
            status: 'pending',
            dueDate: feeType.dueDate,
            academicYear,
            semester,
        });

        const populated = await FeeItem.findById(feeItem.id).populate('feeTypeId');
        const json = populated!.toJSON();

        res.status(201).json({
            ...json,
            feeType: json.feeTypeId,
            feeTypeId: feeTypeId,
        });

        // 🔴 Notify that specific student in real-time
        emitFeeUpdate({ type: 'student_fee', action: 'created', studentId: studentId });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/fees/bulk-assign
 * Admin: Bulk assign fees to multiple students
 */
export const bulkAssignFees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { studentIds, feeTypeId, academicYear, semester } = req.body;

        const feeType = await FeeType.findById(feeTypeId);
        if (!feeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        const feeItems = await Promise.all(
            studentIds.map(async (sid: string) => {
                try {
                    return await FeeItem.create({
                        feeTypeId,
                        studentId: sid,
                        totalAmount: feeType.amount,
                        amountPaid: 0,
                        balance: feeType.amount,
                        status: 'pending',
                        dueDate: feeType.dueDate,
                        academicYear,
                        semester,
                    });
                } catch {
                    // Skip duplicate assignments silently
                    return null;
                }
            })
        );

        const created = feeItems.filter(Boolean);
        
        // 🔴 Notify all students in real-time
        try {
            emitFeeUpdate({ type: 'student_fee', action: 'created' });
        } catch (_) { /* silent */ }

        res.status(201).json(created);
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/fees/types/:feeTypeId/bulk-deadline
 * Admin: Update deadline for ALL student fee items of this type
 */
export const updateBulkFeeTypeDeadline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { feeTypeId } = req.params;
        const { dueDate } = req.body;

        if (!dueDate) {
            res.status(400).json({ message: 'dueDate is required.' });
            return;
        }

        const feeType = await FeeType.findById(feeTypeId);
        if (!feeType) {
            res.status(404).json({ message: 'Fee type not found.' });
            return;
        }

        // 1. Update the FeeType template's dueDate
        feeType.dueDate = new Date(dueDate);
        await feeType.save();

        // 2. Update all associated FeeItem records (for all students)
        await FeeItem.updateMany(
            { feeTypeId: feeType._id },
            { $set: { dueDate: new Date(dueDate) } }
        );

        res.json({
            message: 'Bulk deadline updated successfully for fee type and all student items.',
            dueDate: feeType.dueDate
        });

        // 🔴 Notify all students in real-time
        try {
            emitFeeUpdate({ type: 'fee_type', action: 'updated' });
        } catch (_) { /* silent */ }
    } catch (error) {
        next(error);
    }
};
