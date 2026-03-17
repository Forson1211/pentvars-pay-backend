import { Router } from 'express';
import express from 'express';
import { handleUSSDSession, getUSSDMenu } from '../controllers/ussdController';

const router = Router();

/**
 * Accept both JSON and URL-encoded bodies for the USSD endpoint.
 * Some gateways (Africa's Talking) send application/x-www-form-urlencoded,
 * while others send JSON. We accept both.
 */
router.use(express.urlencoded({ extended: true }));

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
