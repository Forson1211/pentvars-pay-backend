import { AcademicYear, IAcademicYear } from '../models/AcademicYear';
import { FeeTemplate, IFeeTemplate } from '../models/FeeTemplate';
import { StudentFee, IStudentFee, IFeeBreakdown } from '../models/StudentFee';
import { FeeType } from '../models/FeeType';
import { FeeItem } from '../models/FeeItem';
import { Programme } from '../models/Programme';
import { User, IUser } from '../models/User';
import { Types } from 'mongoose';

/**
 * FeeCalculationService
 * 
 * ALL fee calculations happen here — server-side only.
 * No fee logic should ever exist in the frontend.
 */
export class FeeCalculationService {

    /**
     * Get the currently active academic year
     */
    static async getActiveAcademicYear(): Promise<IAcademicYear | null> {
        return AcademicYear.findOne({ isActive: true });
    }

    /**
     * Find the matching FeeTemplate for a student
     */
    static async findMatchingTemplate(
        academicYearId: Types.ObjectId | string,
        studentType: string,
        programmeId: Types.ObjectId | string,
        level: string
    ): Promise<IFeeTemplate | null> {
        return FeeTemplate.findOne({
            academicYear: academicYearId,
            studentType,
            programme: programmeId,
            level,
            isActive: true,
        }).populate('academicYear programme');
    }

    /**
     * Resolve a user's programme to an ObjectId.
     * Tries programmeRef first, then looks up by programme name string.
     */
    static async resolveProgrammeId(user: IUser): Promise<Types.ObjectId | null> {
        // If user has a direct programmeRef ObjectId, verify if it exists in DB
        if (user.programmeRef) {
            const exists = await Programme.findOne({ _id: user.programmeRef, isActive: true });
            if (exists) {
                return user.programmeRef as Types.ObjectId;
            }
        }

        // Otherwise, try to find programme by name
        if (user.programme) {
            const programme = await Programme.findOne({
                programmeName: { $regex: new RegExp(`^${user.programme}$`, 'i') },
                isActive: true,
            });
            if (programme) {
                // Self-heal: update the user document if programmeRef was wrong or missing
                try {
                    await User.updateOne({ _id: user._id }, { programmeRef: programme._id });
                    user.programmeRef = programme._id;
                } catch (err) {
                    console.error('Failed to sync student programmeRef:', err);
                }
                return programme._id as Types.ObjectId;
            }
        }

        return null;
    }

    /**
     * Calculate semester fee breakdown from a FeeTemplate
     * 
     * Semester Total =
     *   tuitionPerSemester
     * + academicUserFee
     * + srcFee
     * + practicalFee
     * + cipsFee
     * + hostelFee
     * - scholarshipDiscount (percentage applied to subtotal)
     * + latePenalty (if applicable)
     */
    static calculateSemesterBreakdown(
        template: IFeeTemplate,
        semester: 1 | 2 = 1,
        isLatePayment: boolean = false
    ): { breakdown: IFeeBreakdown; totalFee: number } {
        const tuition = semester === 2 && template.sem2TuitionPerSemester !== undefined && template.sem2TuitionPerSemester !== null
            ? template.sem2TuitionPerSemester
            : template.tuitionPerSemester;
        const academicUserFee = Math.round((template.academicUserFee || 0) * 100) / 100;
        const srcFee = Math.round((template.srcFee || 0) * 100) / 100;
        const practicalFee = template.practicalFee || 0;
        const cipsFee = template.cipsFee || 0;
        const latePenalty = isLatePayment ? (template.latePenalty || 0) : 0;

        // Calculate subtotal before discount
        // Note: hostelFee is now handled separately as a global FeeItem
        const subtotal = tuition + academicUserFee + srcFee + practicalFee + cipsFee;

        // Apply scholarship discount
        const discountAmount = template.scholarshipDiscount > 0
            ? Math.round((subtotal * template.scholarshipDiscount / 100) * 100) / 100
            : 0;

        const totalFee = Math.round((subtotal - discountAmount + latePenalty) * 100) / 100;

        const breakdown: IFeeBreakdown = {
            tuition,
            academicUserFee,
            srcFee,
            practicalFee,
            cipsFee,
            latePenalty,
            scholarshipDiscount: discountAmount,
        };

        return { breakdown, totalFee };
    }

    /**
     * Get or create a StudentFee record for a student + semester
     * This is the main entry point called when a student accesses their dashboard
     */
    static async getOrCreateStudentFee(
        user: IUser,
        semester: 1 | 2
    ): Promise<IStudentFee | null> {
        // 1. Get active academic year
        const activeYear = await this.getActiveAcademicYear();
        if (!activeYear) {
            throw new Error('No active academic year found');
        }

        // 2. Check if StudentFee already exists
        const existing = await StudentFee.findOne({
            student: user._id,
            academicYear: activeYear._id,
            semester,
        })
            .populate('academicYear')
            .populate('feeTemplate');

        if (existing) {
            // Lazy sync dueDate from template if missing but set on template
            if (!existing.dueDate && (existing.feeTemplate as any)?.dueDate) {
                existing.dueDate = (existing.feeTemplate as any).dueDate;
                await existing.save();
            }

            // Also ensure global fees are synced even if StudentFee exists
            // This handles cases where new exam fees were added mid-semester
            await this.assignApplicableGlobalFees(user);
            return existing;
        }

        // 3. Determine student type
        const studentType = this.determineStudentType(user);

        // 4. Resolve programme ObjectId
        const programmeId = await this.resolveProgrammeId(user);
        if (!programmeId) {
            throw new Error('Student does not have a valid programme assigned. Please update your profile or contact administration.');
        }

        // 5. Find matching FeeTemplate using currentLevel
        const resolvedLevel = user.currentLevel ? user.currentLevel.toString() : (user.level || '100');
        const template = await this.findMatchingTemplate(
            activeYear._id as Types.ObjectId,
            studentType,
            programmeId,
            resolvedLevel
        );

        if (!template) {
            throw new Error(
                `No fee template found for: ${activeYear.yearLabel}, ${studentType}, Level ${resolvedLevel}`
            );
        }

        // 6. Calculate fees server-side
        // hostelFee is now entirely removed from StudentFee
        const { breakdown, totalFee } = this.calculateSemesterBreakdown(
            template,
            semester,
            false
        );

        // 7. Auto-assign Global Fees (Exams, Dues, etc.) before returning
        await this.assignApplicableGlobalFees(user);

        // 8. Create StudentFee record
        const studentFee = await StudentFee.create({
            student: user._id,
            academicYear: activeYear._id,
            feeTemplate: template._id,
            semester,
            breakdown,
            totalFee,
            amountPaid: 0,
            balance: totalFee,
            status: 'unpaid',
            dueDate: template.dueDate || undefined,
        });

        return StudentFee.findById(studentFee._id)
            .populate('academicYear')
            .populate('feeTemplate');
    }

    /**
     * Recalculate a StudentFee when the template changes
     */
    static async recalculateStudentFee(
        studentFeeId: string | Types.ObjectId,
        template: IFeeTemplate
    ): Promise<IStudentFee | null> {
        const studentFee = await StudentFee.findById(studentFeeId);
        if (!studentFee) return null;

        const { breakdown, totalFee } = this.calculateSemesterBreakdown(
            template,
            studentFee.semester,
            studentFee.isLatePayment
        );

        studentFee.breakdown = breakdown;
        studentFee.totalFee = totalFee;
        studentFee.balance = Math.max(0, totalFee - studentFee.amountPaid);
        studentFee.dueDate = template.dueDate || undefined;

        // Update status
        if (studentFee.balance === 0) {
            studentFee.status = 'paid';
        } else if (studentFee.amountPaid > 0) {
            studentFee.status = 'partial';
        } else {
            studentFee.status = 'unpaid';
        }

        await studentFee.save();
        return studentFee;
    }

    /**
     * Process a payment and update StudentFee
     */
    static async processPayment(
        studentFeeId: string | Types.ObjectId,
        amount: number
    ): Promise<IStudentFee | null> {
        const studentFee = await StudentFee.findById(studentFeeId);
        if (!studentFee) {
            throw new Error('Student fee record not found');
        }

        if (amount <= 0) {
            throw new Error('Payment amount must be greater than 0');
        }

        if (amount > studentFee.balance) {
            throw new Error(`Payment amount (${amount}) exceeds outstanding balance (${studentFee.balance})`);
        }

        studentFee.amountPaid += amount;
        studentFee.balance = Math.max(0, studentFee.totalFee - studentFee.amountPaid);

        // Update status
        if (studentFee.balance === 0) {
            studentFee.status = 'paid';
        } else if (studentFee.amountPaid > 0) {
            studentFee.status = 'partial';
        } else {
            studentFee.status = 'unpaid';
        }

        await studentFee.save();
        return studentFee;
    }

    /**
     * Determine student type from user profile
     * Maps stream + nationality to the required studentType
     */
    static determineStudentType(user: IUser): string {
        // International students are always 'international' regardless of stream
        if (user.nationality === 'international') {
            return 'international';
        }
        // Otherwise, use their stream
        return user.stream || 'regular';
    }

    /**
     * Get all StudentFee records for a student across all semesters/years
     */
    static async getAllStudentFees(
        studentId: string | Types.ObjectId
    ): Promise<IStudentFee[]> {
        return StudentFee.find({ student: studentId })
            .populate('academicYear')
            .populate({
                path: 'feeTemplate',
                populate: { path: 'programme' }
            })
            .sort({ createdAt: -1 });
    }

    /**
     * Get student fees for a specific academic year
     */
    static async getStudentFeesByYear(
        studentId: string | Types.ObjectId,
        academicYearId: string | Types.ObjectId
    ): Promise<IStudentFee[]> {
        return StudentFee.find({
            student: studentId,
            academicYear: academicYearId,
        })
            .populate('academicYear')
            .populate({
                path: 'feeTemplate',
                populate: { path: 'programme' }
            })
            .sort({ semester: 1 });
    }

    /**
     * Auto-assign all applicable FeeType items to a student.
     * This creates FeeItem records for things like Exams, Dues, etc.
     */
    static async assignApplicableGlobalFees(user: IUser): Promise<number> {
        try {
            const activeYear = await this.getActiveAcademicYear();
            if (!activeYear) return 0;

            // 1. Find all active FeeTypes for this academic year
            const feeTypes = await FeeType.find({
                academicYear: activeYear.yearLabel,
                isActive: true
            });

            let assignedCount = 0;

            // 2. Filter and assign
            for (const ft of feeTypes) {
                const category = (ft.category || '').toLowerCase();
                const isHostel = category === 'hostel';
                const isExam = ['exam', 'resit', 'supplementary'].includes(category);

                let isEligible = false;

                if (isHostel) {
                    // Hostel: Assigned only if the student has selected the hostel option
                    isEligible = user.hostelOption === true;
                } else if (isExam) {
                    // Exams: Everyone
                    isEligible = true;
                } else {
                    // Other Global Fees: Standard filtering
                    const streamMatch = ft.applicableStream === 'all' || ft.applicableStream === user.stream;
                    const nationalityMatch = ft.applicableNationality === 'all' || ft.applicableNationality === user.nationality;
                    isEligible = streamMatch && nationalityMatch;
                }

                if (!isEligible) continue;

                // 3. Check if already assigned
                const exists = await FeeItem.findOne({
                    studentId: user._id,
                    feeTypeId: ft._id,
                    academicYear: ft.academicYear,
                    semester: ft.semester
                });

                if (!exists) {
                    await FeeItem.create({
                        feeTypeId: ft._id,
                        studentId: user._id,
                        totalAmount: ft.amount,
                        amountPaid: 0,
                        balance: ft.amount,
                        status: 'pending',
                        dueDate: ft.dueDate,
                        academicYear: ft.academicYear,
                        semester: ft.semester
                    });
                    assignedCount++;
                }
            }

            return assignedCount;
        } catch (error) {
            console.error('Error auto-assigning global fees:', error);
            return 0;
        }
    }
}
