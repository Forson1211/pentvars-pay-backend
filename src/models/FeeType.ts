import mongoose, { Document, Schema } from 'mongoose';

export type FeeCategory = 'tuition' | 'hostel' | 'src_dues' | 'exam' | 'resit' | 'supplementary' | 'other';

export interface IFeeType extends Document {
    name: string;
    category: FeeCategory;
    amount: number;
    description: string;
    academicYear: string;
    semester: string;
    dueDate: Date;
    isActive: boolean;
    applicableStream: 'regular' | 'weekend' | 'all';
    applicableNationality: 'ghanaian' | 'international' | 'all';
    createdAt: Date;
    updatedAt: Date;
}

const feeTypeSchema = new Schema<IFeeType>(
    {
        name: {
            type: String,
            required: [true, 'Fee name is required'],
            trim: true,
        },
        category: {
            type: String,
            enum: ['tuition', 'hostel', 'src_dues', 'exam', 'resit', 'supplementary', 'other'],
            required: [true, 'Category is required'],
        },
        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: 0,
        },
        description: {
            type: String,
            trim: true,
            default: '',
        },
        academicYear: {
            type: String,
            required: [true, 'Academic year is required'],
        },
        semester: {
            type: String,
            enum: ['1', '2'],
            required: [true, 'Semester is required'],
        },
        dueDate: {
            type: Date,
            required: [true, 'Due date is required'],
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        applicableStream: {
            type: String,
            enum: ['regular', 'weekend', 'all'],
            default: 'all',
        },
        applicableNationality: {
            type: String,
            enum: ['ghanaian', 'international', 'all'],
            default: 'all',
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

export const FeeType = mongoose.model<IFeeType>('FeeType', feeTypeSchema);
