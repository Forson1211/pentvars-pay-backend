import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: 'student' | 'admin';
    studentId?: string;
    phone?: string;
    programme?: string;
    programmeRef?: any; // ObjectId ref to Programme
    level?: string;
    currentLevel?: number;
    entryLevel?: number;
    graduationLevel?: number;
    currentAcademicYear?: any; // ObjectId ref to AcademicYear
    department?: string;
    campus?: string;
    avatarUrl?: string;
    permissions?: string[];
    position?: string; // e.g. 'Super Admin', 'Accountant', 'Auditor'
    status?: 'active' | 'suspended' | 'graduated';
    stream?: 'regular' | 'weekend';
    nationality?: 'ghanaian' | 'international';
    hostelOption?: boolean;
    lastActive?: Date;
    createdAt: Date;
    updatedAt: Date;
    comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
    {
        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            required: [true, 'Password is required'],
            minlength: 6,
            select: false, // Don't return password by default
        },
        firstName: {
            type: String,
            required: [true, 'First name is required'],
            trim: true,
        },
        lastName: {
            type: String,
            required: [true, 'Last name is required'],
            trim: true,
        },
        role: {
            type: String,
            enum: ['student', 'admin'],
            default: 'student',
        },
        studentId: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
        },
        phone: {
            type: String,
            trim: true,
        },
        programme: {
            type: String,
            trim: true,
        },
        programmeRef: {
            type: Schema.Types.ObjectId,
            ref: 'Programme',
        },
        level: {
            type: String,
            enum: ['100', '200', '300', '400'],
        },
        currentLevel: {
            type: Number,
            default: 100,
        },
        entryLevel: {
            type: Number,
            default: 100,
        },
        graduationLevel: {
            type: Number,
            default: 400,
        },
        currentAcademicYear: {
            type: Schema.Types.ObjectId,
            ref: 'AcademicYear',
        },
        department: {
            type: String,
            trim: true,
        },
        campus: {
            type: String,
            trim: true,
        },
        avatarUrl: {
            type: String,
        },
        position: {
            type: String,
            default: 'Staff',
        },
        status: {
            type: String,
            enum: ['active', 'suspended', 'graduated'],
            default: 'active',
        },
        lastActive: {
            type: Date,
            default: Date.now,
        },
        stream: {
            type: String,
            enum: ['regular', 'weekend'],
            default: 'regular',
        },
        nationality: {
            type: String,
            enum: ['ghanaian', 'international'],
            default: 'ghanaian',
        },
        hostelOption: {
            type: Boolean,
            default: false,
        },
        permissions: [String],
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                ret.id = ret._id;
                delete (ret as any)._id;
                delete (ret as any).__v;
                delete (ret as any).password;
                return ret;
            },
        },
    }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Compare password method
userSchema.methods.comparePassword = async function (
    candidatePassword: string
): Promise<boolean> {
    return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
