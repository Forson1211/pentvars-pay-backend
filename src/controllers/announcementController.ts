import { Request, Response, NextFunction } from 'express';
import { Announcement } from '../models/Announcement';
import { User } from '../models/User';
import { Notification } from '../models/Notification';

/**
 * GET /api/announcements
 * Get all announcements (for students or admins)
 */
export const getAnnouncements = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const filter: Record<string, any> = {};

        // If it's a student, only show 'all' or 'students' announcements
        if (req.user?.role === 'student') {
            filter.recipients = { $in: ['all', 'students'] };
        }

        const announcements = await Announcement.find(filter).sort({ createdAt: -1 });
        res.json(announcements);
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/announcements
 * Admin: Create and broadcast a new announcement
 */
export const createAnnouncement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { title, message, type, recipients } = req.body;

        const announcement = await Announcement.create({
            title,
            message,
            type,
            recipients,
            author: `${req.user!.firstName} ${req.user!.lastName}`,
            authorId: req.user!.id,
        });

        // Broadcast to relevant users via individual notifications
        let userFilter: any = {};
        if (recipients === 'students') {
            userFilter.role = 'student';
        } else if (recipients === 'admins') {
            userFilter.role = 'admin';
        }

        const users = await User.find(userFilter).select('_id');

        if (users.length > 0) {
            const notifications = users.map(user => ({
                recipientId: user._id,
                title: title,
                body: message,
                type: type || 'info',
                data: { announcementId: announcement._id }
            }));

            // Using insertMany for better performance with large student counts
            await Notification.insertMany(notifications);
        }

        res.status(201).json(announcement);
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/announcements/:id
 * Admin: Delete an announcement
 */
export const deleteAnnouncement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const announcement = await Announcement.findById(req.params.id);
        if (!announcement) {
            res.status(404).json({ message: 'Announcement not found.' });
            return;
        }

        // Delete associated notifications
        await Notification.deleteMany({ 'data.announcementId': announcement._id });

        // Delete the announcement itself
        await Announcement.findByIdAndDelete(req.params.id);

        res.json({ message: 'Announcement and associated notifications deleted successfully.' });
    } catch (error) {
        next(error);
    }
};
