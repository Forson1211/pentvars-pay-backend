import { Router } from 'express';
import {
    registerPushToken,
    getNotifications,
    markRead,
    markAllRead
} from '../controllers/notificationController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);
router.get('/', getNotifications);
router.post('/register', registerPushToken);
router.put('/:id/read', markRead);
router.put('/read-all', markAllRead);

export default router;
