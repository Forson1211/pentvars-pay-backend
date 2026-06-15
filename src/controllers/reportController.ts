import { Request, Response, NextFunction } from 'express';
import { StudentFee } from '../models/StudentFee';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';
import mongoose from 'mongoose';

/**
 * GET /api/admin/reports/revenue
 * Admin: Total revenue collected (with grouping options)
 */
export const getRevenueReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, groupBy } = req.query;

        const matchStage: any = { status: 'completed' };

        // If academic year is specified, filter payments by student fees in that year
        let studentFeeIds: any[] | null = null;
        if (academicYear) {
            const fees = await StudentFee.find({ academicYear }).select('_id').lean();
            studentFeeIds = fees.map(f => f._id);
            matchStage.studentFee = { $in: studentFeeIds };
        }

        // Total revenue
        const totalRevenueAgg = await Payment.aggregate([
            { $match: matchStage },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        ]);

        const totalRevenue = totalRevenueAgg[0]?.total || 0;
        const totalTransactions = totalRevenueAgg[0]?.count || 0;

        // Total revenue by category
        const revenueByCategory = await Payment.aggregate([
            { $match: matchStage },
            {
                $lookup: {
                    from: 'feeitems',
                    localField: 'feeItem',
                    foreignField: '_id',
                    as: 'fItem',
                },
            },
            {
                $lookup: {
                    from: 'feetypes',
                    localField: 'fItem.feeTypeId',
                    foreignField: '_id',
                    as: 'fType',
                },
            },
            {
                $project: {
                    amount: 1,
                    category: {
                        $cond: [
                            { $gt: [{ $size: '$fType' }, 0] },
                            {
                                $let: {
                                    vars: { cat: { $arrayElemAt: ['$fType.category', 0] } },
                                    in: {
                                        $cond: [
                                            { $in: ['$$cat', ['hostel', 'resit', 'supplementary', 'exam']] },
                                            '$$cat',
                                            'other'
                                        ]
                                    }
                                }
                            },
                            'academic'
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$category',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]);

        // Revenue by programme (Academic only)
        const revenueByProgramme = await Payment.aggregate([
            { $match: { ...matchStage, studentFee: { $exists: true } } },
            {
                $lookup: {
                    from: 'studentfees',
                    localField: 'studentFee',
                    foreignField: '_id',
                    as: 'fee',
                },
            },
            { $unwind: '$fee' },
            {
                $lookup: {
                    from: 'programmes',
                    localField: 'fee.feeTemplate.programme',
                    foreignField: '_id',
                    as: 'programme',
                },
            },
            // Note: Since feeTemplate.programme might be nested or just ID, this lookup might need refinement depending on seed data structure
            // For now, assume it's linked
            {
                $group: {
                    _id: '$fee.student',
                    total: { $sum: '$amount' },
                },
            }
        ]);

        // Monthly revenue trend (last 12 months)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
        twelveMonthsAgo.setDate(1);
        twelveMonthsAgo.setHours(0, 0, 0, 0);

        const monthlyTrend = await Payment.aggregate([
            {
                $match: {
                    status: 'completed',
                    paymentDate: { $gte: twelveMonthsAgo },
                },
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$paymentDate' },
                        month: { $month: '$paymentDate' },
                    },
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]);

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const formattedMonthlyTrend = monthlyTrend.map(m => ({
            label: `${monthNames[m._id.month - 1]} ${m._id.year}`,
            total: m.total,
            count: m.count,
        }));

        res.json({
            totalRevenue,
            totalTransactions,
            categories: revenueByCategory.map(r => ({
                category: r._id,
                amount: r.total,
                transactions: r.count
            })),
            monthlyTrend: formattedMonthlyTrend,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/reports/outstanding
 * Admin: Total outstanding balances and students owing
 */
export const getOutstandingReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear, programme, studentType, limit: queryLimit } = req.query;
        const resultLimit = parseInt(queryLimit as string) || 100;

        // Build match stage
        const matchStage: any = {
            balance: { $gt: 0 },
        };
        if (academicYear) matchStage.academicYear = new mongoose.Types.ObjectId(academicYear as string);

        // Total outstanding
        const totalOutstandingAgg = await StudentFee.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalOutstanding: { $sum: '$balance' },
                    totalExpected: { $sum: '$totalFee' },
                    totalPaid: { $sum: '$amountPaid' },
                    count: { $sum: 1 },
                },
            },
        ]);

        const totalOutstanding = totalOutstandingAgg[0]?.totalOutstanding || 0;
        const totalExpected = totalOutstandingAgg[0]?.totalExpected || 0;
        const totalPaid = totalOutstandingAgg[0]?.totalPaid || 0;
        const collectionRate = totalExpected > 0 ? Math.round((totalPaid / totalExpected) * 100) : 0;

        // Outstanding by programme
        const outstandingByProgramme = await StudentFee.aggregate([
            { $match: matchStage },
            {
                $lookup: {
                    from: 'feetemplates',
                    localField: 'feeTemplate',
                    foreignField: '_id',
                    as: 'template',
                },
            },
            { $unwind: '$template' },
            {
                $lookup: {
                    from: 'programmes',
                    localField: 'template.programme',
                    foreignField: '_id',
                    as: 'programme',
                },
            },
            { $unwind: '$programme' },
            {
                $group: {
                    _id: '$programme._id',
                    programmeName: { $first: '$programme.programmeName' },
                    faculty: { $first: '$programme.faculty' },
                    totalOutstanding: { $sum: '$balance' },
                    studentCount: { $addToSet: '$student' },
                },
            },
            {
                $project: {
                    programmeName: 1,
                    faculty: 1,
                    totalOutstanding: 1,
                    studentCount: { $size: '$studentCount' },
                },
            },
            { $sort: { totalOutstanding: -1 } },
        ]);

        // Outstanding by student type
        const outstandingByType = await StudentFee.aggregate([
            { $match: matchStage },
            {
                $lookup: {
                    from: 'feetemplates',
                    localField: 'feeTemplate',
                    foreignField: '_id',
                    as: 'template',
                },
            },
            { $unwind: '$template' },
            {
                $group: {
                    _id: '$template.studentType',
                    totalOutstanding: { $sum: '$balance' },
                    studentCount: { $addToSet: '$student' },
                },
            },
            {
                $project: {
                    totalOutstanding: 1,
                    studentCount: { $size: '$studentCount' },
                },
            },
            { $sort: { totalOutstanding: -1 } },
        ]);

        // List of students owing (individual breakdown)
        const studentsOwing = await StudentFee.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$student',
                    totalOutstanding: { $sum: '$balance' },
                    totalFees: { $sum: '$totalFee' },
                    totalPaid: { $sum: '$amountPaid' },
                    feeCount: { $sum: 1 },
                },
            },
            { $sort: { totalOutstanding: -1 } },
            { $limit: resultLimit },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'user',
                },
            },
            { $unwind: '$user' },
            {
                $project: {
                    studentId: '$user.studentId',
                    name: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
                    email: '$user.email',
                    programme: '$user.programme',
                    level: '$user.level',
                    stream: '$user.stream',
                    nationality: '$user.nationality',
                    totalOutstanding: 1,
                    totalFees: 1,
                    totalPaid: 1,
                    feeCount: 1,
                },
            },
        ]);

        res.json({
            summary: {
                totalOutstanding,
                totalExpected,
                totalPaid,
                collectionRate,
                studentsOwingCount: studentsOwing.length,
            },
            outstandingByProgramme: outstandingByProgramme.map(o => ({
                programme: o.programmeName,
                faculty: o.faculty,
                totalOutstanding: o.totalOutstanding,
                studentCount: o.studentCount,
            })),
            outstandingByStudentType: outstandingByType.map(o => ({
                studentType: o._id,
                totalOutstanding: o.totalOutstanding,
                studentCount: o.studentCount,
            })),
            studentsOwing,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/reports/export-csv
 * Admin: Export outstanding report as CSV
 */
export const exportOutstandingCSV = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear } = req.query;

        const matchStage: any = { balance: { $gt: 0 } };
        if (academicYear) matchStage.academicYear = new mongoose.Types.ObjectId(academicYear as string);

        const data = await StudentFee.aggregate([
            { $match: matchStage },
            {
                $lookup: {
                    from: 'users',
                    localField: 'student',
                    foreignField: '_id',
                    as: 'user',
                },
            },
            { $unwind: '$user' },
            {
                $lookup: {
                    from: 'academicyears',
                    localField: 'academicYear',
                    foreignField: '_id',
                    as: 'year',
                },
            },
            { $unwind: '$year' },
            {
                $lookup: {
                    from: 'feetemplates',
                    localField: 'feeTemplate',
                    foreignField: '_id',
                    as: 'template',
                },
            },
            { $unwind: '$template' },
            {
                $lookup: {
                    from: 'programmes',
                    localField: 'template.programme',
                    foreignField: '_id',
                    as: 'programme',
                },
            },
            { $unwind: { path: '$programme', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    studentId: '$user.studentId',
                    name: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
                    email: '$user.email',
                    programme: { $ifNull: ['$programme.programmeName', '$user.programme'] },
                    level: '$user.level',
                    stream: '$user.stream',
                    nationality: '$user.nationality',
                    academicYear: '$year.yearLabel',
                    semester: 1,
                    totalFee: 1,
                    amountPaid: 1,
                    balance: 1,
                    status: 1,
                },
            },
            { $sort: { balance: -1 } },
        ]);

        // Build CSV
        const header = 'Student ID,Name,Email,Programme,Level,Stream,Nationality,Academic Year,Semester,Total Fee,Amount Paid,Balance,Status\n';
        const rows = data.map(d =>
            `"${d.studentId || 'N/A'}","${d.name}","${d.email}","${d.programme || 'N/A'}","${d.level || 'N/A'}","${d.stream || 'N/A'}","${d.nationality || 'N/A'}","${d.academicYear}",${d.semester},${d.totalFee},${d.amountPaid},${d.balance},"${d.status}"`
        );

        const csv = header + rows.join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=outstanding-report.csv');
        res.send(csv);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/reports/dashboard-summary
 * Admin: Quick dashboard summary stats
 */
export const getAdminDashboardSummary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeYear = await AcademicYear.findOne({ isActive: true });

        const [
            totalStudents,
            totalAdmins,
            totalTemplates,
            totalAcademicYears,
        ] = await Promise.all([
            User.countDocuments({ role: 'student' }),
            User.countDocuments({ role: 'admin' }),
            FeeTemplate.countDocuments({ isActive: true }),
            AcademicYear.countDocuments(),
        ]);

        // Current year financial stats
        let currentYearStats = {
            totalFees: 0,
            totalPaid: 0,
            totalOutstanding: 0,
            collectionRate: 0,
            paidCount: 0,
            partialCount: 0,
            unpaidCount: 0,
        };

        if (activeYear) {
            const feeAgg = await StudentFee.aggregate([
                { $match: { academicYear: activeYear._id, semester: 1 } },
                {
                    $group: {
                        _id: null,
                        totalFees: { $sum: '$totalFee' },
                        totalPaid: { $sum: '$amountPaid' },
                        totalOutstanding: { $sum: '$balance' },
                        paidCount: {
                            $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] },
                        },
                        partialCount: {
                            $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] },
                        },
                        unpaidCount: {
                            $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, 1, 0] },
                        },
                    },
                },
            ]);

            const itemAgg = await Payment.aggregate([
                {
                    $match: {
                        paymentDate: {
                            $gte: activeYear.startDate || new Date(new Date().getFullYear(), 0, 1),
                            $lte: activeYear.endDate || new Date(new Date().getFullYear(), 11, 31)
                        },
                        status: 'completed'
                    }
                },
                {
                    $lookup: {
                        from: 'feeitems',
                        localField: 'feeItem',
                        foreignField: '_id',
                        as: 'fItem',
                    },
                },
                {
                    $lookup: {
                        from: 'feetypes',
                        localField: 'fItem.feeTypeId',
                        foreignField: '_id',
                        as: 'fType',
                    },
                },
                {
                    $project: {
                        amount: 1,
                        category: {
                            $cond: [
                                { $gt: [{ $size: '$fType' }, 0] },
                                {
                                    $let: {
                                        vars: { cat: { $arrayElemAt: ['$fType.category', 0] } },
                                        in: {
                                            $cond: [
                                                { $in: ['$$cat', ['hostel', 'resit', 'supplementary', 'exam']] },
                                                '$$cat',
                                                'other'
                                            ]
                                        }
                                    }
                                },
                                'academic'
                            ]
                        }
                    }
                },
                {
                    $group: {
                        _id: '$category',
                        total: { $sum: '$amount' }
                    }
                }
            ]);

            if (feeAgg.length > 0) {
                currentYearStats = {
                    totalFees: feeAgg[0].totalFees,
                    totalPaid: feeAgg[0].totalPaid,
                    totalOutstanding: feeAgg[0].totalOutstanding,
                    collectionRate: feeAgg[0].totalFees > 0
                        ? Math.round((feeAgg[0].totalPaid / feeAgg[0].totalFees) * 100)
                        : 0,
                    paidCount: feeAgg[0].paidCount,
                    partialCount: feeAgg[0].partialCount,
                    unpaidCount: feeAgg[0].unpaidCount,
                    categoryBreakdown: itemAgg.reduce((acc: any, curr: any) => {
                        acc[curr._id] = curr.total;
                        return acc;
                    }, {})
                } as any;
            }
        }

        // Recent transactions (last 10)
        const recentTransactions = await Transaction.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('studentId', 'firstName lastName studentId');

        const recentPayments = recentTransactions.map(t => {
            const json = t.toJSON() as any;
            if (json.studentId) {
                json.student = json.studentId;
                delete json.studentId;
            }
            if (!json.paymentDate) {
                json.paymentDate = json.paidAt || json.createdAt;
            }
            return json;
        });

        // Student distribution
        const studentDistribution = await User.aggregate([
            { $match: { role: 'student' } },
            {
                $group: {
                    _id: {
                        stream: '$stream',
                        nationality: '$nationality',
                    },
                    count: { $sum: 1 },
                },
            },
        ]);

        res.json({
            activeAcademicYear: activeYear?.toJSON() || null,
            counts: {
                totalStudents,
                totalAdmins,
                totalTemplates,
                totalAcademicYears,
            },
            currentYearFinancials: currentYearStats,
            recentPayments,
            studentDistribution: studentDistribution.map(d => ({
                stream: d._id.stream || 'N/A',
                nationality: d._id.nationality || 'N/A',
                count: d.count,
            })),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/students
 * Admin: Get all students with balance info
 */
export const getAllStudentsWithBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { search, stream, nationality, level, page: pageStr, limit: limitStr } = req.query;
        const page = parseInt(pageStr as string) || 1;
        const limit = parseInt(limitStr as string) || 50;
        const skip = (page - 1) * limit;

        // Build user filter
        const userFilter: any = { role: 'student' };
        if (stream) userFilter.stream = stream;
        if (nationality) userFilter.nationality = nationality;
        if (level) userFilter.level = level;
        if (search) {
            userFilter.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { studentId: { $regex: search, $options: 'i' } },
            ];
        }

        const [students, total] = await Promise.all([
            User.find(userFilter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(userFilter),
        ]);

        // Get active year for balance from current year
        const activeYear = await AcademicYear.findOne({ isActive: true });

        // Get the CURRENT semester balance per student.
        // Rule: show semester 1 until it's paid, then show semester 2.
        // We pick the lowest-semester record that is not yet fully paid.
        // If both are paid, we show the most recent semester.
        const studentIds = students.map(s => s._id);
        const feeMatch: any = { student: { $in: studentIds } };
        if (activeYear) feeMatch.academicYear = activeYear._id;

        const allFees = await StudentFee.find(feeMatch)
            .select('student semester totalFee amountPaid balance status')
            .lean();

        // Group by student
        const feesByStudent = new Map<string, typeof allFees>();
        for (const fee of allFees) {
            const key = fee.student.toString();
            if (!feesByStudent.has(key)) feesByStudent.set(key, []);
            feesByStudent.get(key)!.push(fee);
        }

        // Pick the "current" semester fee per student
        const balanceMap = new Map<string, { totalFees: number; totalPaid: number; totalBalance: number; semester: number }>();
        for (const [studentId, fees] of feesByStudent) {
            // Sort by semester ascending
            fees.sort((a, b) => (a.semester as number) - (b.semester as number));
            // Pick first unpaid/partial fee; fallback to last fee if all paid
            const current = fees.find(f => f.status !== 'paid') || fees[fees.length - 1];
            if (current) {
                balanceMap.set(studentId, {
                    totalFees: current.totalFee,
                    totalPaid: current.amountPaid,
                    totalBalance: current.balance,
                    semester: current.semester as number,
                });
            }
        }

        const results = students.map(s => {
            const bal = balanceMap.get(s._id.toString());
            return {
                id: s._id,
                name: `${s.firstName} ${s.lastName}`,
                studentId: s.studentId || 'N/A',
                email: s.email,
                phone: s.phone,
                programme: s.programme || 'N/A',
                level: s.level || 'N/A',
                stream: s.stream || 'regular',
                nationality: s.nationality || 'ghanaian',
                status: s.status || 'active',
                avatarUrl: (s.avatarUrl && (s.avatarUrl.startsWith('data:') || s.avatarUrl.startsWith('http'))) ? s.avatarUrl : undefined,
                totalFees: bal?.totalFees || 0,
                totalPaid: bal?.totalPaid || 0,
                balance: bal?.totalBalance || 0,
                semester: bal?.semester || 1,
                paymentStatus: bal
                    ? (bal.totalBalance === 0 ? 'paid' : (bal.totalPaid > 0 ? 'partial' : 'unpaid'))
                    : 'no-fees',
            };
        });

        res.json({
            students: results,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/students/count
 * Admin: Get student distribution by groups
 */
export const getStudentCountByGroups = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const [byFaculty, byLevel, byType, total] = await Promise.all([
            User.aggregate([
                { $match: { role: 'student' } },
                { $group: { _id: '$faculty', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]),
            User.aggregate([
                { $match: { role: 'student' } },
                { $group: { _id: '$level', count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]),
            User.aggregate([
                { $match: { role: 'student' } },
                {
                    $group: {
                        _id: {
                            stream: '$stream',
                            nationality: '$nationality',
                        },
                        count: { $sum: 1 },
                    },
                },
            ]),
            User.countDocuments({ role: 'student' })
        ]);

        res.json({
            total,
            byFaculty: byFaculty.map(f => ({ name: f._id || 'N/A', count: f.count })),
            byLevel: byLevel.map(l => ({ level: l._id || 'N/A', count: l.count })),
            byType: byType.map(t => ({
                stream: t._id.stream || 'N/A',
                nationality: t._id.nationality || 'N/A',
                count: t.count
            }))
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/payments
 * Admin: Get all real payment records
 */
export const getPaymentList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { status, studentId, page: pageStr, limit: limitStr } = req.query;
        const page = parseInt(pageStr as string) || 1;
        const limit = parseInt(limitStr as string) || 50;
        const skip = (page - 1) * limit;

        const filter: any = {};
        if (status) filter.status = status;
        if (studentId) filter.student = studentId;

        const [payments, total] = await Promise.all([
            Payment.find(filter)
                .sort({ paymentDate: -1 })
                .skip(skip)
                .limit(limit)
                .populate('student', 'firstName lastName studentId email'),
            Payment.countDocuments(filter)
        ]);

        res.json({
            payments: payments.map(p => p.toJSON()),
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/students/:id
 * Admin: Get specific student details + fee history
 */
export const getStudentDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const student = await User.findById(id).lean();

        if (!student || student.role !== 'student') {
            res.status(404).json({ message: 'Student not found' });
            return;
        }

        // Get all fees for this student
        const fees = await StudentFee.find({ student: id })
            .populate('academicYear')
            .sort({ academicYear: -1, semester: -1 })
            .lean();

        // Get all payments for this student
        const payments = await Payment.find({ student: id })
            .sort({ paymentDate: -1 })
            .limit(20)
            .lean();

        res.json({
            student: {
                id: student._id,
                firstName: student.firstName,
                lastName: student.lastName,
                name: `${student.firstName} ${student.lastName}`,
                studentId: student.studentId || 'N/A',
                email: student.email,
                phone: student.phone || 'N/A',
                programme: student.programme || 'N/A',
                level: student.level || 'N/A',
                stream: student.stream || 'regular',
                nationality: student.nationality || 'ghanaian',
                status: student.status || 'active',
                avatarUrl: (student.avatarUrl && (student.avatarUrl.startsWith('data:') || student.avatarUrl.startsWith('http'))) ? student.avatarUrl : undefined,
            },
            fees: fees.map(f => ({
                id: f._id,
                academicYear: (f.academicYear as any)?.yearLabel || 'Unknown',
                semester: f.semester,
                totalFee: f.totalFee,
                amountPaid: f.amountPaid,
                balance: f.balance,
                status: f.balance === 0 ? 'paid' : (f.amountPaid > 0 ? 'partial' : 'unpaid'),
            })),
            payments: payments.map(p => ({
                id: p._id,
                amount: p.amount,
                paymentMethod: p.paymentMethod,
                status: p.status,
                transactionReference: p.transactionReference,
                paymentDate: p.paymentDate,
                description: p.description,
            })),
        });
    } catch (error) {
        next(error);
    }
};
