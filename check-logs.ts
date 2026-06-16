import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';
import { AuditLog } from './src/models/AuditLog';
import { User } from './src/models/User';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        // Force evaluation of User
        console.log('Referencing User model:', User.modelName);
        console.log('Registered models:', mongoose.modelNames());
        
        const count = await AuditLog.countDocuments({});
        console.log('Total AuditLogs in DB:', count);

        // Fetch logs
        const logs = await AuditLog.find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('studentId')
            .lean();

        console.log('Successfully fetched logs:', logs.length);
        if (logs.length > 0) {
            console.log('Sample log:', JSON.stringify(logs[0], null, 2));
            console.log('Do any logs have null/undefined createdAt?');
            const badLogs = await AuditLog.find({ createdAt: { $exists: false } });
            console.log('Logs missing createdAt:', badLogs.length);
        }
        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
