import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { config } from '../config/env';

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || config.mongoURI);
        console.log('Connected to DB');

        const reference = 'USSD-MQQLCPD8-V8NB8C';
        const logs = await AuditLog.find({ reference });
        console.log('Audit logs for reference:', reference, '\n', JSON.stringify(logs, null, 2));

        const recentLogs = await AuditLog.find({ action: { $in: ['payment_success', 'webhook_received', 'ussd_payment_initiated'] } })
            .sort({ createdAt: -1 })
            .limit(10);
        console.log('Recent payment logs:\n', JSON.stringify(recentLogs, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
