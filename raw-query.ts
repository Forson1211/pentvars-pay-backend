import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const db = mongoose.connection.db;
        if (!db) {
            console.error('No database connection');
            return;
        }

        console.log('--- TRANSACTIONS COUNT & STATUS ---');
        const transactions = await db.collection('transactions').find().toArray();
        console.log(`Total transactions: ${transactions.length}`);
        transactions.forEach(t => {
            console.log(`Tx ID: ${t._id}, Ref: ${t.reference}, Status: ${t.status}, Category: ${t.category}, Amount: ${t.amount}`);
        });

        console.log('\n--- PAYMENTS COUNT & STATUS ---');
        const payments = await db.collection('payments').find().toArray();
        console.log(`Total payments: ${payments.length}`);
        payments.forEach(p => {
            console.log(`Pay ID: ${p._id}, Ref: ${p.transactionReference}, Status: ${p.status}, Amount: ${p.amount}`);
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
