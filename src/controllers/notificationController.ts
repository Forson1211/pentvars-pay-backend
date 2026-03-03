import { Request, Response, NextFunction } from 'express';
import { NotificationToken } from '../models/NotificationToken';
import { Notification } from '../models/Notification';

/**
 * POST /api/notifications/register
 * Register a push notification token
 */
export const registerPushToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { token, platform } = req.body;

        // Upsert the token
        await NotificationToken.findOneAndUpdate(
            { userId: req.user!.id, token },
            { userId: req.user!.id, token, platform },
            { upsert: true, new: true }
        );

        res.json({ message: 'Push token registered successfully.' });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/notifications
 * Get all notifications for the authenticated user
 */
export const getNotifications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const notifications = await Notification.find({ recipientId: req.user!.id })
            .sort({ createdAt: -1 })
            .limit(50);
        res.json(notifications);
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/notifications/:id/read
 * Mark a single notification as read
 */
export const markRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, recipientId: req.user!.id },
            { read: true },
            { new: true }
        );

        if (!notification) {
            res.status(404).json({ message: 'Notification not found' });
            return;
        }

        res.json(notification);
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read for the user
 */
export const markAllRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        await Notification.updateMany(
            { recipientId: req.user!.id, read: false },
            { read: true }
        );
        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        next(error);
    }
};
