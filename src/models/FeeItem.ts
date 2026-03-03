import mongoose, { Document, Schema, Types } from 'mongoose';

export type FeeStatus = 'pending' | 'partial' | 'paid' | 'overdue';

export interface IFeeItem extends Document {
    feeTypeId: Types.ObjectId;
    studentId: Types.ObjectId;
    totalAmount: number;
    amountPaid: number;
    balance: number;
    status: FeeStatus;
    dueDate: Date;
    academicYear: string;
    semester: string;
    createdAt: Date;
    updatedAt: Date;
}

const feeItemSchema = new Schema<IFeeItem>(
    {
        feeTypeId: {
            type: Schema.Types.ObjectId,
            ref: 'FeeType',
            required: true,
        },
        studentId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        totalAmount: {
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
            enum: ['pending', 'partial', 'paid', 'overdue'],
            default: 'pending',
        },
        dueDate: {
            type: Date,
            required: true,
        },
        academicYear: {
            type: String,
            required: true,
        },
        semester: {
            type: String,
            enum: ['1', '2'],
            required: true,
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

// Compound index to prevent duplicate fee assignments
feeItemSchema.index({ feeTypeId: 1, studentId: 1, academicYear: 1, semester: 1 }, { unique: true });

export const FeeItem = mongoose.model<IFeeItem>('FeeItem', feeItemSchema);
