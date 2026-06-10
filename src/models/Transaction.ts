import mongoose, { Document, Schema, Types } from 'mongoose';

export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'cancelled';
export type PaymentMethod = 'mobile_money' | 'card' | 'bank_transfer' | 'ussd';
export type FeeCategory = 'academic' | 'hostel' | 'resit' | 'supplementary' | 'exam' | 'other';
export type PaymentChannel = 'paystack' | 'ussd' | 'manual';

export interface ITransaction extends Document {
    studentId: Types.ObjectId;
    feeItemId?: Types.ObjectId;
    studentFeeId?: Types.ObjectId;
    amount: number;
    amountExpected: number; // server-calculated, used for webhook verification
    paymentMethod: PaymentMethod;
    paymentChannel: PaymentChannel;
    status: PaymentStatus;
    reference: string;
    providerReference?: string;
    paystackAccessCode?: string;   // For mobile app Paystack SDK
    paystackAuthorizationUrl?: string; // For web redirect (USSD fallback)
    category: FeeCategory;
    description: string;
    phoneNumber?: string;
    paidAt?: Date;
    webhookVerified: boolean;
    idempotencyKey?: string;  // prevent duplicate initiations
    metadata?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}

const transactionSchema = new Schema<ITransaction>(
    {
        studentId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        feeItemId: {
            type: Schema.Types.ObjectId,
            ref: 'FeeItem',
            required: false,
        },
        studentFeeId: {
            type: Schema.Types.ObjectId,
            ref: 'StudentFee',
            required: false,
        },
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        amountExpected: {
            type: Number,
            required: true,
            min: 0,
        },
        paymentMethod: {
            type: String,
            enum: ['mobile_money', 'card', 'bank_transfer', 'ussd'],
            required: true,
        },
        paymentChannel: {
            type: String,
            enum: ['paystack', 'ussd', 'manual'],
            default: 'paystack',
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled'],
            default: 'pending',
        },
        reference: {
            type: String,
            required: true,
            unique: true,
        },
        providerReference: {
            type: String,
        },
        paystackAccessCode: {
            type: String,
        },
        paystackAuthorizationUrl: {
            type: String,
        },
        category: {
            type: String,
            enum: ['academic', 'hostel', 'resit', 'supplementary', 'exam', 'other'],
            default: 'academic',
        },
        description: {
            type: String,
            default: '',
        },
        phoneNumber: {
            type: String,
        },
        paidAt: {
            type: Date,
        },
        webhookVerified: {
            type: Boolean,
            default: false,
        },
        idempotencyKey: {
            type: String,
            index: true,
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

// Indexes for efficient querying — reference is already unique via field definition
transactionSchema.index({ studentId: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ category: 1 });
transactionSchema.index({ paymentChannel: 1 });
transactionSchema.index({ webhookVerified: 1 });
transactionSchema.index({ createdAt: -1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);
