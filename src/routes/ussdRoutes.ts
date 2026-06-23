import { Router } from 'express';
import express from 'express';
import path from 'path';
import { handleUSSDSession, getUSSDMenu } from '../controllers/ussdController';

const router = Router();

/**
 * Accept both JSON and URL-encoded bodies for the USSD endpoint.
 * Some gateways (Africa's Talking) send application/x-www-form-urlencoded,
 * while others send JSON. We accept both.
 */
router.use(express.urlencoded({ extended: true }));

/**
 * GET /api/ussd/simulator
 * Interactive web mockup for presenting and testing USSD menus
 */
router.get('/simulator', (req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'src/views/simulator.html'));
});

router.get('/simulator.js', (req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'src/views/simulator.js'));
});

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
