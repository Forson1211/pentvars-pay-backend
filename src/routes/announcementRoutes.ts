import { Router } from 'express';
import { getAnnouncements, createAnnouncement, deleteAnnouncement } from '../controllers/announcementController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Viewing announcements requires authentication
router.get('/', authenticate, getAnnouncements);

// Creating/Deleting requires admin role
router.post('/', authenticate, authorize('admin'), createAnnouncement);
router.delete('/:id', authenticate, authorize('admin'), deleteAnnouncement);

export default router;
