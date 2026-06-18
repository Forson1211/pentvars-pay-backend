import { Request, Response, NextFunction } from 'express';
import { FeeCalculationService } from '../services/feeCalculationService';
import { StudentFee } from '../models/StudentFee';
import { FeeItem } from '../models/FeeItem';
import { Payment } from '../models/Payment';
import { AcademicYear } from '../models/AcademicYear';
import { User } from '../models/User';
import { generateReference } from '../utils/helpers';
import { Notification } from '../models/Notification';

/**
 * GET /api/student/dashboard
 * Student: Get complete dashboard data
 * This is the main endpoint — triggers server-side fee calculation
 */
export const getStudentDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = req.user!;

        // Get active academic year
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (!activeYear) {
            res.status(404).json({ message: 'No active academic year found. Contact administration.' });
            return;
        }

        // Enforce active semester: Semester 1 shows first. When Semester 1 is paid, Semester 2 shows.
        let studentFeeSem1: any = await StudentFee.findOne({
            student: user._id,
            academicYear: activeYear._id,
            semester: 1,
        });

        if (!studentFeeSem1) {
            // Generate Semester 1 fee record if it doesn't exist yet
            studentFeeSem1 = await FeeCalculationService.getOrCreateStudentFee(user, 1);
        }

        let semester: 1 | 2 = 1;
        if (studentFeeSem1 && studentFeeSem1.status === 'paid') {
            semester = (parseInt(req.query.semester as string) as 1 | 2) || 2;
        } else {
            semester = 1;
        }

        if (semester !== 1 && semester !== 2) {
            res.status(400).json({ message: 'Semester must be 1 or 2.' });
            return;
        }

        // Get or create student fee (server-side calculation)
        let studentFee = (semester === 1) ? studentFeeSem1 : null;
        if (!studentFee) {
            try {
                studentFee = await FeeCalculationService.getOrCreateStudentFee(user, semester);
            } catch (calcError: any) {
                res.status(404).json({
                    message: calcError.message || 'Unable to calculate fees. Contact administration.',
                });
                return;
            }
        }

        if (!studentFee) {
            res.status(404).json({ message: 'Unable to generate fee record.' });
            return;
        }

        // --- NEW: Fetch General Fees (Exams, Dues, etc.) ---
        const feeItems = await FeeItem.find({
            studentId: user._id,
            academicYear: activeYear.yearLabel,
            semester: semester
        }).populate('feeTypeId');

        // Calculate categorical stats
        const hostelItems = feeItems.filter(i => (i.feeTypeId as any)?.category === 'hostel');
        const examCategories = ['exam', 'resit', 'supplementary'];
        const examItems = feeItems.filter(i => examCategories.includes((i.feeTypeId as any)?.category));
        const otherItems = feeItems.filter(i => !((i.feeTypeId as any)?.category === 'hostel' || examCategories.includes((i.feeTypeId as any)?.category)));

        const hostelStats = {
            total: hostelItems.reduce((sum, i) => sum + i.totalAmount, 0),
            paid: hostelItems.reduce((sum, i) => sum + i.amountPaid, 0),
            balance: hostelItems.reduce((sum, i) => sum + i.balance, 0)
        };

        const examStats = {
            total: examItems.reduce((sum, i) => sum + i.totalAmount, 0),
            paid: examItems.reduce((sum, i) => sum + i.amountPaid, 0),
            balance: examItems.reduce((sum, i) => sum + i.balance, 0)
        };

        const otherStats = {
            total: otherItems.reduce((sum, i) => sum + i.totalAmount, 0),
            paid: otherItems.reduce((sum, i) => sum + i.amountPaid, 0),
            balance: otherItems.reduce((sum, i) => sum + i.balance, 0)
        };

        const academicStats = {
            total: studentFee.totalFee,
            paid: studentFee.amountPaid,
            balance: studentFee.balance,
            status: studentFee.status
        };

        // Parallelize fetching payment history, annual fees, and yearly fee items
        const [payments, academicFees, yearFeeItems] = await Promise.all([
            Payment.find({
                student: user._id,
                status: 'completed',
            }).sort({ paymentDate: -1 }),

            StudentFee.find({
                student: user._id,
                academicYear: activeYear._id,
            }).populate('academicYear').populate({ path: 'feeTemplate', populate: { path: 'programme' } }),

            FeeItem.find({
                studentId: user._id,
                academicYear: activeYear.yearLabel
            }).populate('feeTypeId')
        ]);

        const yearHostel = yearFeeItems.filter(i => (i.feeTypeId as any)?.category === 'hostel');
        const yearExam = yearFeeItems.filter(i => examCategories.includes((i.feeTypeId as any)?.category));

        res.json({
            student: {
                id: user._id,
                name: `${user.firstName} ${user.lastName}`,
                studentId: user.studentId,
                email: user.email,
                programme: user.programme,
                level: user.level,
                stream: user.stream,
                nationality: user.nationality,
            },
            academicYear: activeYear.toJSON(),
            semester,
            currentAcademic: academicStats,
            currentStudentFeeId: studentFee._id, // Exposed so frontend can initiate academic fee payments
            breakdown: studentFee.breakdown,
            hostel: hostelStats,
            exams: examStats,
            other: otherStats,
            generalFees: feeItems.map(item => {
                const json = item.toJSON();
                return {
                    ...json,
                    feeType: json.feeTypeId,
                    category: (json.feeTypeId as any)?.category || 'other'
                };
            }),
            // Depict overall status based on Academic mostly, as it's compulsory
            status: academicStats.balance === 0 ? 'paid' : academicStats.paid > 0 ? 'partial' : 'pending',
            annualSummary: {
                academic: {
                    total: academicFees.reduce((sum, f) => sum + f.totalFee, 0),
                    paid: academicFees.reduce((sum, f) => sum + f.amountPaid, 0),
                    balance: academicFees.reduce((sum, f) => sum + f.balance, 0),
                },
                hostel: {
                    total: yearHostel.reduce((sum, i) => sum + i.totalAmount, 0),
                    paid: yearHostel.reduce((sum, i) => sum + i.amountPaid, 0),
                    balance: yearHostel.reduce((sum, i) => sum + i.balance, 0),
                },
                exams: {
                    total: yearExam.reduce((sum, i) => sum + i.totalAmount, 0),
                    paid: yearExam.reduce((sum, i) => sum + i.amountPaid, 0),
                    balance: yearExam.reduce((sum, i) => sum + i.balance, 0),
                }
            },
            recentPayments: payments.map(p => p.toJSON()),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/student/fees
 * Student: Get all fee records across all academic years
 */
export const getStudentFees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { academicYear } = req.query;

        let fees;
        if (academicYear) {
            fees = await FeeCalculationService.getStudentFeesByYear(req.user!._id, academicYear as string);
        } else {
            fees = await FeeCalculationService.getAllStudentFees(req.user!._id);
        }

        // Calculate totals
        const totalFees = fees.reduce((sum, f) => sum + f.totalFee, 0);
        const totalPaid = fees.reduce((sum, f) => sum + f.amountPaid, 0);
        const totalBalance = fees.reduce((sum, f) => sum + f.balance, 0);

        res.json({
            fees: fees.map(f => f.toJSON()),
            summary: {
                totalFees,
                totalPaid,
                totalBalance,
                count: fees.length,
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/student/payments
 * Student: Get payment history
 */
export const getStudentPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const skip = (page - 1) * limit;

        const [payments, total] = await Promise.all([
            Payment.find({ student: req.user!._id, status: 'completed' })
                .populate({
                    path: 'studentFee',
                    populate: [
                        { path: 'academicYear' },
                        { path: 'feeTemplate', populate: { path: 'programme' } }
                    ]
                })
                .sort({ paymentDate: -1 })
                .skip(skip)
                .limit(limit),
            Payment.countDocuments({ student: req.user!._id, status: 'completed' }),
        ]);

        // Calculate total amounts
        const totalAmount = await Payment.aggregate([
            { $match: { student: req.user!._id, status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);

        res.json({
            payments: payments.map(p => p.toJSON()),
            total,
            totalAmount: totalAmount[0]?.total || 0,
            page,
            limit,
            pages: Math.ceil(total / limit),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/student/pay
 * Student: Make a payment (academic fee OR general fee item)
 */
export const makePayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { studentFeeId, feeItemId, amount, paymentMethod, phoneNumber } = req.body;

        // Validate
        if (!studentFeeId && !feeItemId) {
            res.status(400).json({ message: 'Either studentFeeId or feeItemId is required.' });
            return;
        }
        if (!amount || !paymentMethod) {
            res.status(400).json({ message: 'amount and paymentMethod are required.' });
            return;
        }
        if (amount <= 0) {
            res.status(400).json({ message: 'Payment amount must be greater than 0.' });
            return;
        }

        const reference = generateReference('PAY');
        let payment: any;

        if (studentFeeId) {
            // --- Academic Fee Payment ---
            const studentFee = await StudentFee.findById(studentFeeId)
                .populate('academicYear')
                .populate({ path: 'feeTemplate', populate: { path: 'programme' } });

            if (!studentFee) {
                res.status(404).json({ message: 'Fee record not found.' });
                return;
            }
            if (studentFee.student.toString() !== req.user!._id.toString()) {
                res.status(403).json({ message: 'You can only pay your own fees.' });
                return;
            }
            if (studentFee.status === 'paid') {
                res.status(400).json({ message: 'This fee has already been fully paid.' });
                return;
            }
            if (amount > studentFee.balance) {
                res.status(400).json({
                    message: `Payment amount (GHS ${amount}) exceeds outstanding balance (GHS ${studentFee.balance}).`,
                });
                return;
            }

            const academicYear = studentFee.academicYear as any;
            const description = `Semester ${studentFee.semester} Fee Payment - ${academicYear?.yearLabel || ''}`;

            payment = await Payment.create({
                studentFee: studentFee._id,
                student: req.user!._id,
                amount,
                paymentMethod,
                transactionReference: reference,
                status: 'completed',
                paymentDate: new Date(),
                description,
                metadata: { phoneNumber },
            });

            await FeeCalculationService.processPayment(studentFee._id as any, amount);

        } else {
            // --- General Fee Item Payment ---
            const feeItem = await FeeItem.findById(feeItemId).populate('feeTypeId');

            if (!feeItem) {
                res.status(404).json({ message: 'Fee item not found.' });
                return;
            }
            if (feeItem.studentId.toString() !== req.user!._id.toString()) {
                res.status(403).json({ message: 'You can only pay your own fees.' });
                return;
            }
            if (feeItem.status === 'paid') {
                res.status(400).json({ message: 'This fee has already been fully paid.' });
                return;
            }
            if (amount > feeItem.balance) {
                res.status(400).json({
                    message: `Payment amount (GHS ${amount}) exceeds outstanding balance (GHS ${feeItem.balance}).`,
                });
                return;
            }

            const ftName = (feeItem.feeTypeId as any)?.name || 'General Fee';
            const description = `${ftName} Payment`;

            payment = await Payment.create({
                feeItem: feeItem._id,
                student: req.user!._id,
                amount,
                paymentMethod,
                transactionReference: reference,
                status: 'completed',
                paymentDate: new Date(),
                description,
                metadata: { phoneNumber },
            });

            feeItem.amountPaid += amount;
            feeItem.balance = Math.max(0, feeItem.totalAmount - feeItem.amountPaid);
            feeItem.status = feeItem.balance === 0 ? 'paid' : 'partial';
            await feeItem.save();
        }

        // Notify admins
        try {
            const admins = await User.find({ role: 'admin' }).select('_id');
            const studentName = `${req.user!.firstName} ${req.user!.lastName}`;
            if (admins.length > 0) {
                const notifications = admins.map(admin => ({
                    recipientId: admin._id,
                    title: 'New Payment Received',
                    body: `${studentName} paid GHS ${Number(amount).toFixed(2)}.`,
                    type: 'success' as const,
                    data: { paymentId: payment._id, studentId: req.user!._id },
                }));
                await Notification.insertMany(notifications);
            }
        } catch (notifyError) {
            console.error('Error notifying admins:', notifyError);
        }

        res.status(201).json({
            message: 'Payment processed successfully.',
            payment: payment.toJSON(),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/student/payment-receipt/:paymentId
 * Student: Generate receipt for a payment
 */
export const getPaymentReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate({
                path: 'studentFee',
                populate: [
                    { path: 'academicYear' },
                    { path: 'feeTemplate', populate: { path: 'programme' } }
                ]
            })
            .populate('student', 'firstName lastName studentId email programme level');

        if (!payment) {
            res.status(404).json({ message: 'Payment not found.' });
            return;
        }

        if (payment.student.toString() !== req.user!._id.toString() && req.user!.role !== 'admin') {
            res.status(403).json({ message: 'Access denied.' });
            return;
        }

        const student = await User.findById(payment.student);
        const studentFee = payment.studentFee as any;
        const academicYear = studentFee?.academicYear;

        const receipt = {
            receiptNumber: `REC-${payment.transactionReference}`,
            paymentId: payment._id,
            transactionReference: payment.transactionReference,
            studentName: student ? `${student.firstName} ${student.lastName}` : 'N/A',
            studentId: student?.studentId || 'N/A',
            programme: student?.programme || 'N/A',
            level: student?.level || 'N/A',
            academicYear: academicYear?.yearLabel || 'N/A',
            semester: studentFee?.semester || 'N/A',
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            paymentDate: payment.paymentDate,
            description: payment.description,
            status: payment.status,
            generatedAt: new Date().toISOString(),
        };

        res.json(receipt);
    } catch (error) {
        next(error);
    }
};
