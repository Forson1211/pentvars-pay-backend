import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { Transaction } from './src/models/Transaction';
import { AuditLog } from './src/models/AuditLog';

async function run() {
    try {
        const mongoURI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pentvars-pay';
        await mongoose.connect(mongoURI);
        console.log('MongoDB Connected.');

        console.log('\n--- LATEST 10 TRANSACTIONS ---');
        const txs = await Transaction.find().sort({ createdAt: -1 }).limit(10);
        txs.forEach(t => {
            console.log(`ID: ${t._id} | Ref: ${t.reference} | Status: ${t.status} | Phone: ${t.phoneNumber} | Amt: ${t.amount} | Date: ${t.createdAt}`);
        });

        console.log('\n--- LATEST 10 AUDIT LOGS ---');
        const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(10);
        logs.forEach(l => {
            console.log(`Action: ${l.action} | Ref: ${l.reference} | Date: ${l.createdAt} | Details:`, JSON.stringify(l.details));
        });

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB Disconnected.');
    }
}

run();
