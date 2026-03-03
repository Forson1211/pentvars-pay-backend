import mongoose, { Document, Schema, Types } from 'mongoose';

export type FeePaymentStatus = 'paid' | 'partial' | 'unpaid';

export interface IFeeBreakdown {
    tuition: number;
    academicUserFee: number;
    srcFee: number;
    practicalFee: number;
    cipsFee: number;
    latePenalty: number;
    scholarshipDiscount: number;
}

export interface IStudentFee extends Document {
    student: Types.ObjectId;
    academicYear: Types.ObjectId;
    feeTemplate: Types.ObjectId;
    semester: 1 | 2;
    breakdown: IFeeBreakdown;
    totalFee: number;
    amountPaid: number;
    balance: number;
    status: FeePaymentStatus;
    dueDate?: Date;
    isLatePayment: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const feeBreakdownSchema = new Schema<IFeeBreakdown>(
    {
        tuition: { type: Number, default: 0, min: 0 },
        academicUserFee: { type: Number, default: 0, min: 0 },
        srcFee: { type: Number, default: 0, min: 0 },
        practicalFee: { type: Number, default: 0, min: 0 },
        cipsFee: { type: Number, default: 0, min: 0 },
        latePenalty: { type: Number, default: 0, min: 0 },
        scholarshipDiscount: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
);

const studentFeeSchema = new Schema<IStudentFee>(
    {
        student: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Student reference is required'],
        },
        academicYear: {
            type: Schema.Types.ObjectId,
            ref: 'AcademicYear',
            required: [true, 'Academic year is required'],
        },
        feeTemplate: {
            type: Schema.Types.ObjectId,
            ref: 'FeeTemplate',
            required: [true, 'Fee template is required'],
        },
        semester: {
            type: Number,
            enum: [1, 2],
            required: [true, 'Semester is required'],
        },
        breakdown: {
            type: feeBreakdownSchema,
            required: true,
        },
        totalFee: {
            type: Number,
            required: true,
            min: 0,
        },
        amountPaid: {
            type: Number,
            default: 0,
            min: 0,
        },
        balance: {
            type: Number,
            required: true,
            min: 0,
        },
        status: {
            type: String,
            enum: ['paid', 'partial', 'unpaid'],
            default: 'unpaid',
        },
        dueDate: {
            type: Date,
        },
        isLatePayment: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                ret.id = ret._id;
                delete (ret as any)._id;
                delete (ret as any).__v;
                return ret;
            },
        },
    }
);

// Prevent duplicate student fee records for same student + academic year + semester
studentFeeSchema.index(
    { student: 1, academicYear: 1, semester: 1 },
    { unique: true }
);

// Performance indexes
studentFeeSchema.index({ student: 1 });
studentFeeSchema.index({ academicYear: 1 });
studentFeeSchema.index({ status: 1 });
studentFeeSchema.index({ feeTemplate: 1 });

export const StudentFee = mongoose.model<IStudentFee>('StudentFee', studentFeeSchema);
