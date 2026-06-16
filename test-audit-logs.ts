import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';
import { AuditLog } from './src/models/AuditLog';
import { User } from './src/models/User'; // Ensure User model is registered!

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const count = await AuditLog.countDocuments({});
        console.log('Total AuditLogs in DB:', count);

        const logs = await AuditLog.find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('studentId', 'firstName lastName studentId programme')
            .lean();

        console.log('Sample logs:', JSON.stringify(logs, null, 2));

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
