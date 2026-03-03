import mongoose, { Document, Schema, Types } from 'mongoose';

export interface INotificationToken extends Document {
    userId: Types.ObjectId;
    token: string;
    platform: string;
    createdAt: Date;
    updatedAt: Date;
}

const notificationTokenSchema = new Schema<INotificationToken>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        token: {
            type: String,
            required: true,
        },
        platform: {
            type: String,
            enum: ['ios', 'android', 'web'],
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

notificationTokenSchema.index({ userId: 1, token: 1 }, { unique: true });

export const NotificationToken = mongoose.model<INotificationToken>(
    'NotificationToken',
    notificationTokenSchema
);
