import dotenv from 'dotenv';
dotenv.config();

export const config = {
    port: parseInt(process.env.PORT || '5000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    mongoURI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pentvars-pay',
    jwt: {
        secret: process.env.JWT_SECRET || 'default-secret-change-me',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-me',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    },
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:8081',
    paystack: {
        secretKey: process.env.PAYSTACK_SECRET_KEY || '',
        publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    },
    ussd: {
        serviceCode: process.env.USSD_SERVICE_CODE || '*920*1#',
        provider: process.env.USSD_PROVIDER || 'africas_talking',
        demoMode: process.env.USSD_DEMO_MODE === 'true',
    },
    reconciliation: {
        enabled: process.env.RECONCILIATION_ENABLED !== 'false',
    },
};

