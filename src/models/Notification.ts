import mongoose, { Document, Schema, Types } from 'mongoose';

export interface INotification extends Document {
    recipientId: Types.ObjectId;
    title: string;
    body: string;
    type: 'info' | 'urgent' | 'success';
    read: boolean;
    data?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
    {
        recipientId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        body: {
            type: String,
            required: true,
        },
        type: {
            type: String,
            enum: ['info', 'urgent', 'success'],
            default: 'info',
        },
        read: {
            type: Boolean,
            default: false,
        },
        data: {
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

// Index for fast retrieval of unread notifications for a user
notificationSchema.index({ recipientId: 1, read: 1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
