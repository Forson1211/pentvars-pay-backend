import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { FeeItem } from '../models/FeeItem';
import { StudentFee } from '../models/StudentFee';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { FeeCalculationService } from '../services/feeCalculationService';
import { emitFeeUpdate } from '../services/socketService';
import { generateToken, generateRefreshToken } from '../utils/helpers';

/**
 * GET /api/admin/students
 * Admin: Get all students with their total balances
 */
export const getAllStudents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        // 1. Get all users with the role 'student'
        const students = await User.find({ role: 'student' }).sort({ createdAt: -1 });

        // 2. For each student, calculate their total balance from FeeItems
        const studentsWithBalance = await Promise.all(
            students.map(async (student) => {
                const feeItems = await FeeItem.find({ studentId: student._id });
                const totalBalance = feeItems.reduce((acc, item) => acc + item.balance, 0);

                // Determine status based on balance
                // If they have any fee item that is overdue, they are overdue
                // If they have 0 balance across all, they are paid
                // Otherwise partial
                let status = 'paid';
                if (totalBalance > 0) {
                    const hasOverdue = feeItems.some(item => item.status === 'overdue');
                    status = hasOverdue ? 'overdue' : 'partial';

                    // If they haven't paid anything at all on any fee
                    const totalPaid = feeItems.reduce((acc, item) => acc + item.amountPaid, 0);
                    if (totalPaid === 0 && totalBalance > 0) {
                        status = 'pending';
                    }
                }

                return {
                    id: student._id,
                    name: `${student.firstName} ${student.lastName}`,
                    studentId: student.studentId || 'N/A',
                    programme: student.programme || 'N/A',
                    level: student.level || 'N/A',
                    balance: totalBalance,
                    status: status,
                    email: student.email,
                    phone: student.phone
                };
            })
        );

        res.json(studentsWithBalance);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/stats/summary
 * Admin: Get a quick summary of student counts and finances
 */
export const getAdminSummary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const [totalStudents, feeItems] = await Promise.all([
            User.countDocuments({ role: 'student' }),
            FeeItem.find({})
        ]);

        const totalOutstanding = feeItems.reduce((acc, item) => acc + item.balance, 0);

        res.json({
            totalStudents,
            totalOutstanding
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/hierarchy
 * Admin: Get all administrative staff
 */
export const getAdminHierarchy = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const admins = await User.find({ role: 'admin' }).sort({ createdAt: 1 });
        res.json(admins);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/create-staff
 * Admin: Create a new administrative staff member
 */
export const createStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, password, firstName, lastName, position, phone, permissions } = req.body;

        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            res.status(400).json({ message: 'User with this email already exists.' });
            return;
        }

        if (!password || password.length < 6) {
            res.status(400).json({ message: 'Password must be at least 6 characters long.' });
            return;
        }

        const staff = await User.create({
            email: email.toLowerCase(),
            password,
            firstName,
            lastName,
            phone,
            role: 'admin',
            position: position || 'Administrator',
            permissions: permissions || ['all'],
            status: 'active'
        });

        // Remove password from response (already handled by select:false, but to be safe)
        const staffObj = staff.toJSON();

        res.status(201).json(staffObj);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/impersonate
 * Admin: Switch to another user account (impersonate)
 */
export const impersonateUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { userId } = req.body;

        if (!userId) {
            res.status(400).json({ message: 'User ID is required.' });
            return;
        }

        const user = await User.findById(userId);
        if (!user) {
            res.status(404).json({ message: 'User not found.' });
            return;
        }

        // Generate new tokens for the target user
        const token = generateToken(user.id, user.role);
        const refreshToken = generateRefreshToken(user.id, user.role);

        res.json({
            user: user.toJSON(),
            token,
            refreshToken,
            message: `Switched to ${user.firstName} ${user.lastName}`
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/staff/:id
 * Admin: Update administrative staff details (position, status, etc.)
 */
export const updateStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { position, status, firstName, lastName, phone, permissions } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            id,
            {
                ...(position && { position }),
                ...(status && { status }),
                ...(firstName && { firstName }),
                ...(lastName && { lastName }),
                ...(phone && { phone }),
                ...(permissions && { permissions })
            },
            { new: true }
        );

        if (!updatedUser) {
            res.status(404).json({ message: 'Staff member not found.' });
            return;
        }

        res.json(updatedUser.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/staff/:id
 * Admin: Remove an administrative staff member
 */
export const deleteStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself (basic safety)
        if (req.user && req.user._id.toString() === id) {
            res.status(400).json({ message: 'You cannot delete your own account.' });
            return;
        }

        const deletedUser = await User.findByIdAndDelete(id);

        if (!deletedUser) {
            res.status(404).json({ message: 'Staff member not found.' });
            return;
        }

        res.json({ message: 'Staff member removed successfully.' });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/reports/financial
 * Admin: Get detailed financial breakdown for reports
 */
export const getFinancialReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const feeItems = await FeeItem.find({}).populate('feeTypeId');

        const totalCollected = feeItems.reduce((acc, f) => acc + f.amountPaid, 0);
        const totalPending = feeItems.reduce((acc, f) => acc + f.balance, 0);
        const collectionRate = totalCollected > 0 ? Math.round((totalCollected / (totalCollected + totalPending)) * 100) : 0;

        // Breakdown by category
        const categories = ['tuition', 'hostel', 'src_dues', 'exam', 'resit', 'supplementary', 'other'];
        const breakdown = categories.map(cat => {
            const items = feeItems.filter(f => (f.feeTypeId as any)?.category === cat);
            const collected = items.reduce((acc, f) => acc + f.amountPaid, 0);
            const pending = items.reduce((acc, f) => acc + f.balance, 0);

            return {
                name: cat.charAt(0).toUpperCase() + cat.slice(1).replace('_', ' '),
                collected,
                pending,
                count: items.length
            };
        }).filter(b => b.count > 0);

        res.json({
            totalCollected,
            totalPending,
            collectionRate,
            breakdown
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/stats/advanced
 * Admin: Get advanced analytics (student distribution, fee status, etc.)
 */
export const getAdvancedStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const [
            streamDistribution,
            nationalityDistribution,
            levelDistribution,
            feeItems
        ] = await Promise.all([
            // Student distribution by Stream
            User.aggregate([
                { $match: { role: 'student' } },
                { $group: { _id: '$stream', count: { $sum: 1 } } }
            ]),
            // Student distribution by Nationality
            User.aggregate([
                { $match: { role: 'student' } },
                { $group: { _id: '$nationality', count: { $sum: 1 } } }
            ]),
            // Student distribution by Level
            User.aggregate([
                { $match: { role: 'student' } },
                { $group: { _id: '$level', count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]),
            // Fee status distribution (we can't easily aggregate on virtuals, so we'll fetch then process)
            FeeItem.find({}).select('status balance amountPaid')
        ]);

        // Process fee status distribution
        const feeStatusCounts = {
            paid: 0,
            partial: 0,
            pending: 0,
            overdue: 0
        };

        feeItems.forEach(item => {
            if (item.status === 'paid') feeStatusCounts.paid++;
            else if (item.status === 'partial') feeStatusCounts.partial++;
            else if (item.status === 'overdue') feeStatusCounts.overdue++;
            else feeStatusCounts.pending++;
        });

        res.json({
            studentAnalytics: {
                byStream: streamDistribution.map(s => ({ label: s._id || 'N/A', value: s.count })),
                byNationality: nationalityDistribution.map(n => ({ label: n._id || 'N/A', value: n.count })),
                byLevel: levelDistribution.map(l => ({ label: `Level ${l._id || '?'}`, value: l.count }))
            },
            feeAnalytics: {
                statusDistribution: [
                    { label: 'Fully Paid', value: feeStatusCounts.paid, color: '#10B981' },
                    { label: 'Partial', value: feeStatusCounts.partial, color: '#F59E0B' },
                    { label: 'Pending', value: feeStatusCounts.pending, color: '#6B7280' },
                    { label: 'Overdue', value: feeStatusCounts.overdue, color: '#EF4444' }
                ]
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/students/:id/hostel-status
 * Admin: Toggle hostel eligibility for a student.
 * The payment engine always re-checks this before processing hostel payments.
 */
export const toggleHostelStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { hostelOption } = req.body;

        if (typeof hostelOption !== 'boolean') {
            res.status(400).json({ message: 'hostelOption must be a boolean (true/false).' });
            return;
        }

        const student = await User.findByIdAndUpdate(
            id,
            { hostelOption },
            { new: true }
        );

        if (!student) {
            res.status(404).json({ message: 'Student not found.' });
            return;
        }

        res.json({
            message: `Hostel status ${hostelOption ? 'enabled' : 'disabled'} for ${student.firstName} ${student.lastName}.`,
            student: {
                id: student.id,
                studentId: student.studentId,
                hostelOption: student.hostelOption,
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/reset-all-student-fees
 * Admin: Hard-reset ALL student fee records to unpaid/pending.
 *
 * This operation:
 *  1. Resets StudentFee.amountPaid → 0, balance → totalFee, status → 'unpaid'
 *  2. Resets FeeItem.amountPaid → 0, balance → totalAmount, status → 'pending'
 *  3. Deletes ALL Payment records (the source of truth for past payments)
 *  4. Deletes ALL Transaction records (the Paystack log)
 *  5. Auto-creates StudentFee records for every student who has none (fixes NO-FEES)
 *  6. Broadcasts a fee:updated event so all connected students see the change instantly
 */
export const resetAllStudentFees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        // ── Step 1: Reset all StudentFee records ──────────────────────────────
        const studentFees = await StudentFee.find({});
        let sfReset = 0;
        for (const sf of studentFees) {
            sf.amountPaid = 0;
            sf.balance = sf.totalFee;
            sf.status = 'unpaid';
            await sf.save();
            sfReset++;
        }

        // ── Step 2: Reset all FeeItem records ────────────────────────────────
        const feeItems = await FeeItem.find({});
        let fiReset = 0;
        for (const fi of feeItems) {
            fi.amountPaid = 0;
            fi.balance = fi.totalAmount;
            fi.status = 'pending';
            await fi.save();
            fiReset++;
        }

        // ── Step 3: Delete ALL Payment + Transaction records ─────────────────
        const [payDel, transDel] = await Promise.all([
            Payment.deleteMany({}),
            Transaction.deleteMany({}),
        ]);

        // ── Step 4: Auto-create StudentFee for students who have NONE ─────────
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        const allStudents = await User.find({ role: 'student' });
        let autoCreated = 0;
        const errors: string[] = [];

        for (const student of allStudents) {
            if (activeYear) {
                try {
                    let created = false;
                    const sem1Fee = await StudentFee.findOne({ student: student._id, academicYear: activeYear._id, semester: 1 });
                    if (!sem1Fee) {
                        await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                        created = true;
                    }
                    const sem2Fee = await StudentFee.findOne({ student: student._id, academicYear: activeYear._id, semester: 2 });
                    if (!sem2Fee) {
                        await FeeCalculationService.getOrCreateStudentFee(student as any, 2);
                        created = true;
                    }
                    // Always run assignApplicableGlobalFees to ensure no missing global fee items
                    const assignedCount = await FeeCalculationService.assignApplicableGlobalFees(student as any);
                    if (created || assignedCount > 0) {
                        autoCreated++;
                    }
                } catch (e: any) {
                    errors.push(`${student.firstName} ${student.lastName}: ${e.message}`);
                }
            } else {
                // Fallback if no active academic year
                const existingFee = await StudentFee.findOne({ student: student._id });
                if (!existingFee) {
                    try {
                        await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                        await FeeCalculationService.assignApplicableGlobalFees(student as any);
                        autoCreated++;
                    } catch (e: any) {
                        errors.push(`${student.firstName} ${student.lastName}: ${e.message}`);
                    }
                }
            }
        }

        // ── Step 5: Broadcast real-time update to all connected students ──────
        try {
            emitFeeUpdate({ type: 'student_fee', action: 'updated' });
        } catch (_) {/* silent */ }

        res.json({
            message: 'All student fee records have been reset to unpaid.',
            summary: {
                studentFeesReset: sfReset,
                feeItemsReset: fiReset,
                paymentsDeleted: payDel.deletedCount,
                transactionsDeleted: transDel.deletedCount,
                autoCreatedFees: autoCreated,
            },
            errors: errors.length > 0 ? errors : undefined,
        });
    } catch (error) {
        next(error);
    }
};
