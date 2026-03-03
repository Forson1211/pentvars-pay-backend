import mongoose, { Document, Schema } from 'mongoose';

export interface IFaculty extends Document {
    name: string;
    code?: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const facultySchema = new Schema<IFaculty>(
    {
        name: {
            type: String,
            required: [true, 'Faculty name is required'],
            unique: true,
            trim: true,
        },
        code: {
            type: String,
            trim: true,
            uppercase: true,
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

facultySchema.index({ isActive: 1 });

export const Faculty = mongoose.model<IFaculty>('Faculty', facultySchema);
