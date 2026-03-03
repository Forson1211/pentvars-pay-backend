import { Router } from 'express';
import { handleUSSDSession, getUSSDMenu } from '../controllers/ussdController';

const router = Router();

/**
 * POST /api/ussd/session
 * Called by telecom USSD gateway (Africa's Talking, Hubtel, etc.)
 * No authentication required — authentication is done via Student ID in menu
 */
router.post('/session', handleUSSDSession);

/**
 * GET /api/ussd/menu
 * Documentation endpoint — returns menu structure
 */
router.get('/menu', getUSSDMenu);

export default router;
