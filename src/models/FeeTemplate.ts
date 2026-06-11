import mongoose, { Document, Schema, Types } from 'mongoose';

export type StudentType = 'regular' | 'weekend' | 'international';

export interface IFeeTemplate extends Document {
    academicYear: Types.ObjectId;
    studentType: StudentType;
    faculty: Types.ObjectId; // ref to Faculty
    programme: Types.ObjectId;
    level: string;
    tuitionPerSemester: number;
    sem2TuitionPerSemester?: number; // Optional, defaults to tuitionPerSemester
    academicUserFee: number; // Annual
    srcFee: number; // Annual
    practicalFee: number;
    cipsFee: number;
    latePenalty: number;
    scholarshipDiscount: number; // Percentage (0-100)
    installmentAllowed: boolean;
    maxInstallments: number;
    dueDate?: Date;
    isActive: boolean;
    createdBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const feeTemplateSchema = new Schema<IFeeTemplate>(
    {
        academicYear: {
            type: Schema.Types.ObjectId,
            ref: 'AcademicYear',
            required: [true, 'Academic year is required'],
        },
        studentType: {
            type: String,
            enum: ['regular', 'weekend', 'international'],
            required: [true, 'Student type is required'],
        },
        faculty: {
            type: Schema.Types.ObjectId,
            ref: 'Faculty',
            required: [true, 'Faculty is required'],
        },
        programme: {
            type: Schema.Types.ObjectId,
            ref: 'Programme',
            required: [true, 'Programme is required'],
        },
        level: {
            type: String,
            enum: ['100', '200', '300', '400'],
            required: [true, 'Level is required'],
        },
        tuitionPerSemester: {
            type: Number,
            required: [true, 'Tuition per semester is required'],
            min: 0,
        },
        sem2TuitionPerSemester: {
            type: Number,
            min: 0,
        },
        academicUserFee: {
            type: Number,
            default: 0,
            min: 0,
        },
        srcFee: {
            type: Number,
            default: 0,
            min: 0,
        },
        practicalFee: {
            type: Number,
            default: 0,
            min: 0,
        },
        cipsFee: {
            type: Number,
            default: 0,
            min: 0,
        },
        latePenalty: {
            type: Number,
            default: 0,
            min: 0,
        },
        scholarshipDiscount: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        installmentAllowed: {
            type: Boolean,
            default: true,
        },
        maxInstallments: {
            type: Number,
            default: 3,
            min: 1,
            max: 12,
        },
        dueDate: {
            type: Date,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
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

// CRITICAL: Prevent duplicate fee templates
// Unique per: academicYear + faculty + programme + level + studentType
feeTemplateSchema.index(
    { academicYear: 1, faculty: 1, programme: 1, level: 1, studentType: 1 },
    { unique: true }
);

// Indexes for efficient querying
feeTemplateSchema.index({ academicYear: 1 });
feeTemplateSchema.index({ faculty: 1 });
feeTemplateSchema.index({ studentType: 1 });
feeTemplateSchema.index({ programme: 1 });
feeTemplateSchema.index({ isActive: 1 });

export const FeeTemplate = mongoose.model<IFeeTemplate>('FeeTemplate', feeTemplateSchema);
