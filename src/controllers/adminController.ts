import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { FeeItem } from '../models/FeeItem';
import { StudentFee } from '../models/StudentFee';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { FeeCalculationService } from '../services/feeCalculationService';
import { emitFeeUpdate } from '../services/socketService';
import { FeeType } from '../models/FeeType';
import { generateToken, generateRefreshToken } from '../utils/helpers';
import { AuditLog } from '../models/AuditLog';

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

const isSuperAdminUser = (user: any): boolean => {
    if (!user || user.role !== 'admin') return false;
    const superuserPositions = ['Super Admin', 'System Administrator', 'Rector'];
    return (
        superuserPositions.includes(user.position || '') ||
        (user.permissions && user.permissions.includes('all'))
    );
};

/**
 * POST /api/admin/create-staff
 * Admin: Create a new administrative staff member
 */
export const createStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!isSuperAdminUser(req.user)) {
            res.status(403).json({ message: 'Only a Super Admin can create admin accounts.' });
            return;
        }
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

        const staffObj = staff.toJSON();

        AuditLog.create({
            action: 'staff_created',
            details: {
                adminId: req.user?.id,
                adminName: `${req.user?.firstName} ${req.user?.lastName}`,
                newStaffId: staff.id,
                newStaffName: `${firstName} ${lastName}`,
                position: position || 'Administrator',
                email: email.toLowerCase(),
            },
            isError: false,
        }).catch(console.error);

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
        if (!isSuperAdminUser(req.user)) {
            res.status(403).json({ message: 'Only a Super Admin can change admin roles.' });
            return;
        }
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

        // Audit: log role/status change
        const changeDetails: Record<string, any> = {
            adminId: req.user?.id,
            adminName: `${req.user?.firstName} ${req.user?.lastName}`,
            targetStaffId: id,
            targetStaffName: `${updatedUser.firstName} ${updatedUser.lastName}`,
        };
        if (position) changeDetails.newPosition = position;
        if (status) changeDetails.newStatus = status;
        if (permissions) changeDetails.newPermissions = permissions;

        if (position || status || permissions) {
            AuditLog.create({
                action: position ? 'staff_role_changed' : 'staff_status_changed',
                details: changeDetails,
                isError: false,
            }).catch(console.error);
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
        if (!isSuperAdminUser(req.user)) {
            res.status(403).json({ message: 'Only a Super Admin can delete admin accounts.' });
            return;
        }
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

        AuditLog.create({
            action: 'staff_deleted',
            details: {
                adminId: req.user?.id,
                adminName: `${req.user?.firstName} ${req.user?.lastName}`,
                deletedStaffId: id,
                deletedStaffName: `${deletedUser.firstName} ${deletedUser.lastName}`,
                email: deletedUser.email,
            },
            isError: false,
        }).catch(console.error);

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

        // --- Automatically sync FeeItem for Hostel based on the new hostelOption ---
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        if (activeYear) {
            const hostelFeeType = await FeeType.findOne({
                academicYear: activeYear.yearLabel,
                category: 'hostel',
                isActive: true
            });

            if (hostelFeeType) {
                if (hostelOption) {
                    // Enable hostel: create FeeItem if it doesn't exist
                    const exists = await FeeItem.findOne({
                        studentId: student._id,
                        feeTypeId: hostelFeeType._id
                    });
                    if (!exists) {
                        await FeeItem.create({
                            feeTypeId: hostelFeeType._id,
                            studentId: student._id,
                            totalAmount: hostelFeeType.amount,
                            amountPaid: 0,
                            balance: hostelFeeType.amount,
                            status: 'pending',
                            dueDate: hostelFeeType.dueDate,
                            academicYear: hostelFeeType.academicYear,
                            semester: hostelFeeType.semester || 1
                        });
                    }
                } else {
                    // Disable hostel: delete unpaid FeeItem
                    await FeeItem.deleteMany({
                        studentId: student._id,
                        feeTypeId: hostelFeeType._id,
                        amountPaid: 0
                    });
                }
            }
        }

        // Broadcast update to student in real-time
        try {
            emitFeeUpdate({ type: 'student_fee', action: 'updated', studentId: student._id.toString() });
        } catch (_) { /* silent */ }

        AuditLog.create({
            action: 'hostel_status_changed',
            studentId: student._id as any,
            details: {
                adminId: req.user?.id,
                adminName: `${req.user?.firstName} ${req.user?.lastName}`,
                studentName: `${student.firstName} ${student.lastName}`,
                hostelOption,
                timestamp: new Date().toISOString(),
            },
            isError: false,
        }).catch(console.error);

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
        console.log('[RESET] Starting bulk reset of all student fees...');
        const startTime = Date.now();

        // ── Step 1 & 2: Reset StudentFee & FeeItem using highly efficient bulk updates ──
        // updateMany with aggregation pipeline lets us refer to fields within the same document (e.g. balance = totalFee / totalAmount)
        const [sfResult, fiResult] = await Promise.all([
            StudentFee.updateMany({}, [
                { $set: { amountPaid: 0, balance: "$totalFee", status: "unpaid" } }
            ]),
            FeeItem.updateMany({}, [
                { $set: { amountPaid: 0, balance: "$totalAmount", status: "pending" } }
            ])
        ]);

        console.log(`[RESET] StudentFees updated: ${sfResult.modifiedCount}, FeeItems updated: ${fiResult.modifiedCount}`);

        // ── Step 3: Delete ALL Payment + Transaction records ──
        const [payDel, transDel] = await Promise.all([
            Payment.deleteMany({}),
            Transaction.deleteMany({}),
        ]);

        console.log(`[RESET] Deleted payments: ${payDel.deletedCount}, transactions: ${transDel.deletedCount}`);

        // ── Step 4: Auto-create StudentFee for students who have NONE in parallel batches ──
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        const allStudents = await User.find({ role: 'student' });
        let autoCreated = 0;
        const errors: string[] = [];

        if (activeYear) {
            // Find students who already have a Sem 1 fee document to skip querying in the loop
            const existingSem1Fees = await StudentFee.find({
                academicYear: activeYear._id,
                semester: 1
            }).select('student').lean();
            const studentIdsWithFees = new Set(existingSem1Fees.map(f => f.student.toString()));

            // Process students in concurrent batches of 15 to handle high latency
            const batchSize = 15;
            for (let i = 0; i < allStudents.length; i += batchSize) {
                const batch = allStudents.slice(i, i + batchSize);
                await Promise.all(batch.map(async (student) => {
                    try {
                        const hasSem1 = studentIdsWithFees.has(student._id.toString());
                        if (!hasSem1) {
                            await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                            autoCreated++;
                        } else {
                            await FeeCalculationService.assignApplicableGlobalFees(student as any);
                        }
                    } catch (e: any) {
                        errors.push(`${student.firstName} ${student.lastName}: ${e.message}`);
                    }
                }));
            }
        } else {
            // Fallback if no active academic year
            const batchSize = 15;
            for (let i = 0; i < allStudents.length; i += batchSize) {
                const batch = allStudents.slice(i, i + batchSize);
                await Promise.all(batch.map(async (student) => {
                    try {
                        const existingFee = await StudentFee.findOne({ student: student._id });
                        if (!existingFee) {
                            await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                            autoCreated++;
                        } else {
                            await FeeCalculationService.assignApplicableGlobalFees(student as any);
                        }
                    } catch (e: any) {
                        errors.push(`${student.firstName} ${student.lastName}: ${e.message}`);
                    }
                }));
            }
        }

        console.log(`[RESET] Auto-created student fees: ${autoCreated}. Total duration: ${Date.now() - startTime}ms`);

        // ── Step 5: Broadcast real-time update to all connected students ──
        try {
            emitFeeUpdate({ type: 'student_fee', action: 'updated' });
        } catch (_) {/* silent */ }

        AuditLog.create({
            action: 'fee_reset',
            details: {
                adminId: req.user?.id,
                adminName: `${req.user?.firstName} ${req.user?.lastName}`,
                studentFeesReset: sfResult.modifiedCount,
                feeItemsReset: fiResult.modifiedCount,
                paymentsDeleted: payDel.deletedCount,
                transactionsDeleted: transDel.deletedCount,
                autoCreatedFees: autoCreated,
                timestamp: new Date().toISOString(),
            },
            isError: false,
        }).catch(console.error);

        res.json({
            message: 'All student fee records have been reset to unpaid.',
            summary: {
                studentFeesReset: sfResult.modifiedCount,
                feeItemsReset: fiResult.modifiedCount,
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

// ─── AUDIT LOG MANAGEMENT ─────────────────────────────────────────────────────

/**
 * GET /api/admin/audit-logs
 * Admin: Get paginated audit logs with filters
 */
export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
        const skip = (page - 1) * limit;

        const filter: Record<string, any> = {};

        if (req.query.action && req.query.action !== 'all') {
            const actionQuery = req.query.action as string;
            if (actionQuery.includes(',')) {
                filter.action = { $in: actionQuery.split(',').map(a => a.trim()) };
            } else {
                filter.action = actionQuery;
            }
        }
        if (req.query.isError !== undefined && req.query.isError !== '') {
            filter.isError = req.query.isError === 'true';
        }
        if (req.query.studentId) {
            // Search by student ObjectId or by admin name in details
            const searchTerm = (req.query.studentId as string).trim();
            const matchedStudents = await User.find({
                $or: [
                    { studentId: { $regex: searchTerm, $options: 'i' } },
                    { firstName: { $regex: searchTerm, $options: 'i' } },
                    { lastName: { $regex: searchTerm, $options: 'i' } },
                ]
            }).select('_id').lean();

            if (matchedStudents.length > 0) {
                filter.studentId = { $in: matchedStudents.map(s => s._id) };
            } else {
                // Fall back to reference/details search
                filter.$or = [
                    { reference: { $regex: searchTerm, $options: 'i' } },
                    { 'details.adminName': { $regex: searchTerm, $options: 'i' } },
                    { 'details.studentName': { $regex: searchTerm, $options: 'i' } },
                ];
            }
        }
        if (req.query.reference) {
            filter.reference = { $regex: req.query.reference as string, $options: 'i' };
        }
        if (req.query.startDate || req.query.endDate) {
            filter.createdAt = {};
            if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate as string);
            if (req.query.endDate) {
                const end = new Date(req.query.endDate as string);
                end.setHours(23, 59, 59, 999);
                filter.createdAt.$lte = end;
            }
        }

        const [logs, total] = await Promise.all([
            AuditLog.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('studentId', 'firstName lastName studentId programme')
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        res.json({
            logs: logs.map(log => ({ ...log, id: log._id })),
            total,
            page,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/audit-logs/:id
 * Admin: Delete a single audit log entry
 */
export const deleteAuditLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const log = await AuditLog.findByIdAndDelete(id);
        if (!log) {
            res.status(404).json({ message: 'Audit log entry not found.' });
            return;
        }
        res.json({ message: 'Audit log entry deleted.' });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/audit-logs
 * Admin: Bulk-clear audit logs (optionally filter by date range or action)
 */
export const clearAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const filter: Record<string, any> = {};

        if (req.query.action && req.query.action !== 'all') {
            filter.action = req.query.action;
        }
        if (req.query.before) {
            filter.createdAt = { $lte: new Date(req.query.before as string) };
        }
        if (req.query.isError !== undefined && req.query.isError !== '') {
            filter.isError = req.query.isError === 'true';
        }

        const result = await AuditLog.deleteMany(filter);

        res.json({
            message: `${result.deletedCount} audit log ${result.deletedCount === 1 ? 'entry' : 'entries'} deleted.`,
            deletedCount: result.deletedCount,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/admin/students
 * Admin: Register a new student with a generated temporal password
 */
export const createStudent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, firstName, lastName, studentId, phone, programme, level, stream, nationality } = req.body;

        if (!email || !firstName || !lastName || !studentId) {
            res.status(400).json({ message: 'Email, First Name, Last Name, and Student ID are required.' });
            return;
        }

        // Check if user already exists (by email or student ID case-insensitively)
        const existingUser = await User.findOne({
            $or: [
                { email: email.toLowerCase() },
                { studentId: { $regex: new RegExp('^' + studentId.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i') } }
            ],
        });

        if (existingUser) {
            res.status(400).json({ message: 'User with this email or student ID already exists.' });
            return;
        }

        // Generate temporal password: PV-<cleanStudentID> or custom body password
        let temporalPassword = req.body.password;
        if (!temporalPassword) {
            const cleanId = studentId.trim().replace(/[^a-zA-Z0-9]/g, '');
            temporalPassword = `PV-${cleanId || Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        }

        const initialLevelStr = level || '100';
        const initialLevelNum = parseInt(initialLevelStr) || 100;

        const student = await User.create({
            email: email.toLowerCase(),
            password: temporalPassword,
            firstName,
            lastName,
            role: 'student',
            studentId: studentId.trim(),
            phone,
            programme,
            level: initialLevelStr,
            currentLevel: initialLevelNum,
            entryLevel: initialLevelNum,
            graduationLevel: 400,
            stream: stream || 'regular',
            nationality: nationality || 'ghanaian',
            status: 'active',
        });

        // Assign active academic year and resolve Programme Reference
        try {
            const activeYear = await FeeCalculationService.getActiveAcademicYear();
            if (activeYear) {
                student.currentAcademicYear = activeYear._id;
            }

            const programmeId = await FeeCalculationService.resolveProgrammeId(student as any);
            if (programmeId) {
                student.programmeRef = programmeId;
            }

            await student.save();

            // Assign Applicable Global Fees (Exams, Dues, etc.)
            await FeeCalculationService.assignApplicableGlobalFees(student as any);
        } catch (progError) {
            console.error('Error resolving references or assigning fees during admin registration:', progError);
        }

        // Create audit log
        AuditLog.create({
            action: 'student_created',
            details: {
                adminId: req.user?.id,
                adminName: `${req.user?.firstName} ${req.user?.lastName}`,
                studentDbId: student.id,
                studentId: student.studentId,
                studentName: `${firstName} ${lastName}`,
                email: email.toLowerCase(),
                temporalPassword,
            },
            isError: false,
        }).catch(console.error);

        const studentObj = student.toJSON();

        res.status(201).json({
            message: 'Student registered successfully.',
            student: studentObj,
            temporalPassword,
        });
    } catch (error) {
        next(error);
    }
};

