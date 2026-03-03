import { Router } from 'express';
import {
    register,
    login,
    logout,
    refreshToken,
    getProfile,
    updateProfile,
    changePassword,
    forgotPassword,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Public routes
router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refreshToken);
router.post('/forgot-password', forgotPassword);

// Protected routes (require authentication)
router.post('/logout', authenticate, logout);
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);
router.put('/change-password', authenticate, changePassword);

export default router;
