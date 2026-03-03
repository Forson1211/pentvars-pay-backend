import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { User, IUser } from '../models/User';

// Extend Express Request to include user
declare global {
    namespace Express {
        interface Request {
            user?: IUser;
        }
    }
}

/**
 * JWT Authentication middleware
 * Verifies the Bearer token and attaches user to request
 */
export const authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ message: 'Access denied. No token provided.' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, config.jwt.secret) as { id: string; role: string };

        const user = await User.findById(decoded.id);
        if (!user) {
            res.status(401).json({ message: 'Invalid token. User not found.' });
            return;
        }

        req.user = user;
        next();
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            res.status(401).json({ message: 'Token expired.' });
            return;
        }
        res.status(401).json({ message: 'Invalid token.' });
    }
};

/**
 * Role-based authorization middleware
 * Must be used AFTER authenticate middleware
 */
export const authorize = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ message: 'Not authenticated.' });
            return;
        }

        if (!roles.includes(req.user.role)) {
            res.status(403).json({ message: 'Not authorized to access this resource.' });
            return;
        }

        next();
    };
};
