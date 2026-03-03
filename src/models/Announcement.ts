import mongoose, { Document, Schema, Types } from 'mongoose';

export type AnnouncementType = 'info' | 'urgent' | 'success';

export interface IAnnouncement extends Document {
    title: string;
    message: string;
    type: AnnouncementType;
    author: string;
    authorId: Types.ObjectId;
    recipients: 'all' | 'students' | 'admins';
    createdAt: Date;
    updatedAt: Date;
}

const announcementSchema = new Schema<IAnnouncement>(
    {
        title: {
            type: String,
            required: [true, 'Title is required'],
            trim: true,
        },
        message: {
            type: String,
            required: [true, 'Message is required'],
        },
        type: {
            type: String,
            enum: ['info', 'urgent', 'success'],
            default: 'info',
        },
        author: {
            type: String,
            required: true,
        },
        authorId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        recipients: {
            type: String,
            enum: ['all', 'students', 'admins'],
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

export const Announcement = mongoose.model<IAnnouncement>('Announcement', announcementSchema);
