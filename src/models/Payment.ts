import mongoose, { Document, Schema, Types } from 'mongoose';

export type PaymentMethod = 'mobile_money' | 'card' | 'bank_transfer' | 'ussd';
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';

export interface IPayment extends Document {
    studentFee?: Types.ObjectId;
    feeItem?: Types.ObjectId;
    student: Types.ObjectId;
    amount: number;
    paymentMethod: PaymentMethod;
    transactionReference: string;
    providerReference?: string;
    status: PaymentStatus;
    paymentDate: Date;
    description: string;
    metadata?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
    {
        studentFee: {
            type: Schema.Types.ObjectId,
            ref: 'StudentFee',
            required: false,
        },
        feeItem: {
            type: Schema.Types.ObjectId,
            ref: 'FeeItem',
            required: false,
        },
        student: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Student reference is required'],
        },
        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: [1, 'Amount must be at least 1'],
        },
        paymentMethod: {
            type: String,
            enum: ['mobile_money', 'card', 'bank_transfer', 'ussd'],
            required: [true, 'Payment method is required'],
        },
        transactionReference: {
            type: String,
            required: true,
            unique: true,
        },
        providerReference: {
            type: String,
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed', 'refunded'],
            default: 'pending',
        },
        paymentDate: {
            type: Date,
            default: Date.now,
        },
        description: {
            type: String,
            default: 'Fee Payment',
        },
        metadata: {
            type: Object,
            default: {},
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

// Indexes for efficient querying
paymentSchema.index({ student: 1, createdAt: -1 });
paymentSchema.index({ studentFee: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ paymentDate: -1 });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
