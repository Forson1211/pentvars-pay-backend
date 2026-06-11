import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { initSocket } from './services/socketService';
import { ReconciliationService } from './services/reconciliationService';

import connectDB from './config/db';
import { config } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';

// Route imports
import authRoutes from './routes/authRoutes';
import feeRoutes from './routes/feeRoutes';
import paymentRoutes from './routes/paymentRoutes';
import notificationRoutes from './routes/notificationRoutes';
import adminRoutes from './routes/adminRoutes';
import announcementRoutes from './routes/announcementRoutes';
import studentRoutes from './routes/studentRoutes';
import publicRoutes from './routes/publicRoutes';
import ussdRoutes from './routes/ussdRoutes';

const app = express();

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'ngrok-skip-browser-warning', 'Bypass-Tunnel-Reminder'],
    credentials: true,
}));

// ─── CRITICAL: Paystack Webhook Raw Body Capture ──────────────────────────────
// The webhook MUST receive the raw body (as string) BEFORE any JSON parsing
// in order to verify the HMAC-SHA512 signature from Paystack.
// We capture rawBody for the webhook route, then apply JSON parsing everywhere else.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), (req: Request, _res: Response, next: NextFunction) => {
    (req as any).rawBody = req.body.toString('utf8');
    try {
        req.body = JSON.parse((req as any).rawBody);
    } catch {
        req.body = {};
    }
    next();
});

// ─── JSON Body Parsing (for all other routes) ─────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (config.nodeEnv === 'development') {
    app.use(morgan('dev'));
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Stricter rate limit for payment initiation
const paymentLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // max 10 payment initiations per 5 min
    message: { message: 'Too many payment attempts. Please wait and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// USSD needs generous limits (telecom gateways send many requests)
const ussdLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: 'END Rate limit exceeded.',
});

app.use('/api/', globalLimiter);
app.use('/api/payments/initiate', paymentLimiter);
app.use('/api/ussd', ussdLimiter);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'PentVars Pay API',
        version: '2.0.1-exact-fees-fix',
        timestamp: new Date().toISOString(),
        paystack: config.paystack.secretKey && config.paystack.secretKey !== 'sk_test_your_paystack_secret_key' ? 'configured' : 'not_configured',
    });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/ussd', ussdRoutes);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
const startServer = async () => {
    await connectDB();

    // Create a raw http.Server so Socket.IO can share the same port
    const httpServer = http.createServer(app);

    // Attach Socket.IO
    initSocket(httpServer);

    httpServer.listen(config.port, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║    🎓 PentVars Pay API Server v2.0           ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(`║  🌐 Port:     ${String(config.port).padEnd(28)}║`);
        console.log(`║  🔧 Mode:     ${config.nodeEnv.padEnd(28)}║`);
        console.log(`║  📡 API:      http://localhost:${config.port}/api     ║`);
        console.log(`║  🔴 Live:     ws://localhost:${config.port}           ║`);
        console.log(`║  💳 Paystack: ${config.paystack.secretKey && config.paystack.secretKey !== 'sk_test_your_paystack_secret_key' ? '✅ Configured            ' : '⚠️  Not Configured      '}║`);
        console.log(`║  📞 USSD:     /api/ussd/session               ║`);
        console.log(`║  🔗 Webhook:  /api/payments/webhook           ║`);
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    });

    // ── Schedule daily reconciliation ──────────────────────────────────────
    if (config.nodeEnv === 'production') {
        ReconciliationService.scheduleDailyReconciliation();
    }
};

startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

export default app;
