import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAcademicYear extends Document {
    yearLabel: string; // e.g. "2024/2025"
    isActive: boolean;
    startDate?: Date;
    endDate?: Date;
    createdBy?: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const academicYearSchema = new Schema<IAcademicYear>(
    {
        yearLabel: {
            type: String,
            required: [true, 'Year label is required (e.g. "2024/2025")'],
            unique: true,
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: false,
        },
        startDate: {
            type: Date,
        },
        endDate: {
            type: Date,
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
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

// Pre-save hook: ensure only ONE academic year is active at a time
academicYearSchema.pre('save', async function (next) {
    if (this.isActive && this.isModified('isActive')) {
        await mongoose.model('AcademicYear').updateMany(
            { _id: { $ne: this._id } },
            { $set: { isActive: false } }
        );
    }
    next();
});

// Index
academicYearSchema.index({ isActive: 1 });

export const AcademicYear = mongoose.model<IAcademicYear>('AcademicYear', academicYearSchema);
