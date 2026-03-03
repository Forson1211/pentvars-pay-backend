import jwt from 'jsonwebtoken';
import { config } from '../config/env';

/**
 * Generate access token
 */
export const generateToken = (userId: string, role: string): string => {
    return jwt.sign(
        { id: userId, role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn as any }
    );
};

/**
 * Generate refresh token
 */
export const generateRefreshToken = (userId: string, role: string): string => {
    return jwt.sign(
        { id: userId, role },
        config.jwt.refreshSecret,
        { expiresIn: config.jwt.refreshExpiresIn as any }
    );
};

/**
 * Verify refresh token
 */
export const verifyRefreshToken = (token: string): { id: string; role: string } => {
    return jwt.verify(token, config.jwt.refreshSecret) as { id: string; role: string };
};

/**
 * Generate a unique payment reference
 */
export const generateReference = (prefix: string = 'PAY'): string => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
};
