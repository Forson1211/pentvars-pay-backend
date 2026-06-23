import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../utils/helpers';
import { FeeCalculationService } from '../services/feeCalculationService';
import { emitProfileUpdate } from '../services/socketService';

/**
 * POST /api/auth/register
 * Register a new student account
 */
export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, password, firstName, lastName, studentId, phone, programme, level, stream, nationality } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({
            $or: [{ email: email.toLowerCase() }, ...(studentId ? [{ studentId }] : [])],
        });

        if (existingUser) {
            res.status(400).json({ message: 'User with this email or student ID already exists.' });
            return;
        }

        // Create user
        const initialLevelStr = level || '100';
        const initialLevelNum = parseInt(initialLevelStr);

        const user = await User.create({
            email: email.toLowerCase(),
            password,
            firstName,
            lastName,
            role: 'student',
            studentId,
            phone,
            programme,
            level: initialLevelStr,
            currentLevel: initialLevelNum,
            entryLevel: initialLevelNum,
            graduationLevel: 400, // Or calculate based on programme
            stream: stream || 'regular',
            nationality: nationality || 'ghanaian',
            status: 'active',
        });

        // --- Assign active academic year and resolve Programme Reference ---
        try {
            const activeYear = await FeeCalculationService.getActiveAcademicYear();
            if (activeYear) {
                user.currentAcademicYear = activeYear._id;
            }

            const programmeId = await FeeCalculationService.resolveProgrammeId(user);
            if (programmeId) {
                user.programmeRef = programmeId;
            }

            await user.save();

            // --- Assign Applicable Global Fees (Exams, Dues, etc.) ---
            await FeeCalculationService.assignApplicableGlobalFees(user);
        } catch (progError) {
            console.error('Error resolving initial references during registration:', progError);
        }

        // --- Initial Fee Preparation ---
        // We don't pre-create the fee record here to allow for level/stream changes.
        // The FeeCalculationService will lazily create it when the student first
        // accesses their dashboard via /api/student/dashboard.


        // --- Notify Admins ---
        try {
            const admins = await User.find({ role: 'admin' }).select('_id');
            if (admins.length > 0) {
                const adminNotifications = admins.map(admin => ({
                    recipientId: admin._id,
                    title: 'New Student Registration',
                    body: `${firstName} ${lastName} (${studentId}) has just registered.`,
                    type: 'info',
                    data: { studentId: user._id }
                }));
                await Notification.insertMany(adminNotifications);
            }
        } catch (notifyError) {
            console.error('Error notifying admins of registration:', notifyError);
        }

        // Generate tokens
        const token = generateToken(user.id, user.role);
        const refreshToken = generateRefreshToken(user.id, user.role);

        const userObj = user.toJSON();
        // Filter out local file paths from old versions that won't work across devices
        if (userObj.avatarUrl && !userObj.avatarUrl.startsWith('data:') && !userObj.avatarUrl.startsWith('http')) {
            userObj.avatarUrl = undefined;
        }

        res.status(201).json({
            user: userObj,
            token,
            refreshToken,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/auth/login
 * Login with email and password
 */
export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, studentId, username, identifier, password } = req.body;
        const loginValue = (email || studentId || username || identifier || '').trim();

        if (!loginValue) {
            res.status(400).json({ message: 'Email or Student ID is required.' });
            return;
        }

        // Find user by email OR studentId (case-insensitive)
        const user = await User.findOne({
            $or: [
                { email: loginValue.toLowerCase() },
                { studentId: { $regex: new RegExp('^' + loginValue.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i') } }
            ]
        }).select('+password');

        if (!user) {
            res.status(401).json({ message: 'Invalid credentials.' });
            return;
        }

        // Compare password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            res.status(401).json({ message: 'Invalid email or password.' });
            return;
        }

        // Generate tokens
        const token = generateToken(user.id, user.role);
        const refreshToken = generateRefreshToken(user.id, user.role);

        const userObj = user.toJSON();
        // Filter out local file paths from old versions that won't work across devices
        if (userObj.avatarUrl && !userObj.avatarUrl.startsWith('data:') && !userObj.avatarUrl.startsWith('http')) {
            userObj.avatarUrl = undefined;
        }

        res.json({
            user: userObj,
            token,
            refreshToken,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/auth/refresh
 * Refresh the access token
 */
export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { refreshToken: incomingToken } = req.body;

        if (!incomingToken) {
            res.status(400).json({ message: 'Refresh token is required.' });
            return;
        }

        const decoded = verifyRefreshToken(incomingToken);
        const user = await User.findById(decoded.id);

        if (!user) {
            res.status(401).json({ message: 'Invalid refresh token.' });
            return;
        }

        const newToken = generateToken(user.id, user.role);
        const newRefreshToken = generateRefreshToken(user.id, user.role);

        res.json({
            token: newToken,
            refreshToken: newRefreshToken,
        });
    } catch (error) {
        res.status(401).json({ message: 'Invalid or expired refresh token.' });
    }
};

/**
 * POST /api/auth/logout
 * Logout (client should also clear tokens)
 */
export const logout = async (_req: Request, res: Response): Promise<void> => {
    // In a production app, you'd blacklist the token here
    res.json({ message: 'Logged out successfully.' });
};

/**
 * GET /api/auth/profile
 * Get current user's profile
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
    const userObj = req.user!.toJSON();
    // Filter out local file paths
    if (userObj.avatarUrl && !userObj.avatarUrl.startsWith('data:') && !userObj.avatarUrl.startsWith('http')) {
        userObj.avatarUrl = undefined;
    }
    res.json(userObj);
};

/**
 * PUT /api/auth/profile
 * Update current user's profile
 */
export const updateProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const allowedFields = ['firstName', 'lastName', 'phone', 'programme', 'level', 'department', 'campus', 'avatarUrl'];
        const updates: Record<string, any> = {};

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        const user = await User.findByIdAndUpdate(
            req.user!.id,
            { $set: updates },
            { new: true, runValidators: true }
        );

        if (!user) {
            res.status(404).json({ message: 'User not found.' });
            return;
        }

        const userObj = user.toJSON();
        // Filter out local file paths
        if (userObj.avatarUrl && !userObj.avatarUrl.startsWith('data:') && !userObj.avatarUrl.startsWith('http')) {
            userObj.avatarUrl = undefined;
        }

        // Real-time synchronization for multi-device users
        emitProfileUpdate(user.id, userObj);

        res.json(userObj);
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/auth/change-password
 * Change password for authenticated user
 */
export const changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { currentPassword, newPassword } = req.body;

        const user = await User.findById(req.user!.id).select('+password');
        if (!user) {
            res.status(404).json({ message: 'User not found.' });
            return;
        }

        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            res.status(400).json({ message: 'Current password is incorrect.' });
            return;
        }

        user.password = newPassword;
        await user.save();

        res.json({ message: 'Password updated successfully.' });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/auth/forgot-password
 * Request password reset (simulated)
 */
export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() });

        // Always respond with success to prevent email enumeration
        res.json({
            message: 'If an account with that email exists, a password reset link has been sent.',
        });
    } catch (error) {
        next(error);
    }
};
