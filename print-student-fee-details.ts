import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const db = mongoose.connection.db;
        if (!db) return;

        const feeRecord = await db.collection('studentfees').findOne({ _id: new mongoose.Types.ObjectId('6a2a2f22a096cb8349ee6433') });
        if (!feeRecord) {
            console.log('Fee record not found');
            return;
        }

        console.log('--- STUDENT FEE RECORD ---');
        console.log(JSON.stringify(feeRecord, null, 2));

        if (feeRecord.feeTemplate) {
            console.log('\n--- MATCHING TEMPLATE ---');
            const template = await db.collection('feetemplates').findOne({ _id: feeRecord.feeTemplate });
            console.log(JSON.stringify(template, null, 2));
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
