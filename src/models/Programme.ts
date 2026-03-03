import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IProgramme extends Document {
    faculty: Types.ObjectId; // ref to Faculty
    programmeName: string;
    code?: string;
    duration?: number; // in years
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const programmeSchema = new Schema<IProgramme>(
    {
        faculty: {
            type: Schema.Types.ObjectId,
            ref: 'Faculty',
            required: [true, 'Faculty is required'],
        },
        programmeName: {
            type: String,
            required: [true, 'Programme name is required'],
            trim: true,
        },
        code: {
            type: String,
            trim: true,
            uppercase: true,
        },
        duration: {
            type: Number,
            min: 1,
            max: 7,
            default: 4,
        },
        isActive: {
            type: Boolean,
            default: true,
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

// Compound unique index: no duplicate programme within same faculty
programmeSchema.index({ faculty: 1, programmeName: 1 }, { unique: true });
programmeSchema.index({ isActive: 1 });

export const Programme = mongoose.model<IProgramme>('Programme', programmeSchema);
