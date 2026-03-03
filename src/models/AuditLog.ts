import mongoose, { Document, Schema, Types } from 'mongoose';

export type AuditAction =
    | 'payment_initiated'
    | 'payment_success'
    | 'payment_failed'
    | 'webhook_received'
    | 'webhook_verified'
    | 'webhook_rejected'
    | 'duplicate_blocked'
    | 'amount_mismatch'
    | 'ussd_session_started'
    | 'ussd_payment_initiated'
    | 'reconciliation_run'
    | 'reconciliation_flag';

export interface IAuditLog extends Document {
    action: AuditAction;
    reference?: string;
    studentId?: Types.ObjectId;
    amount?: number;
    category?: string;
    channel?: string;
    ip?: string;
    userAgent?: string;
    details?: Record<string, any>;
    isError: boolean;
    createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
    {
        action: {
            type: String,
            required: true,
            index: true,
        },
        reference: {
            type: String,
            index: true,
        },
        studentId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            index: true,
        },
        amount: { type: Number },
        category: { type: String },
        channel: { type: String },
        ip: { type: String },
        userAgent: { type: String },
        details: { type: Object },
        isError: { type: Boolean, default: false },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
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

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ reference: 1, action: 1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
