import mongoose from 'mongoose';
import { Transaction } from '../models/Transaction';
import { config } from '../config/env';

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || config.mongoURI);
        console.log('Connected to DB');

        const reference = 'PVP-MQLCFM29-PHH2DQ';
        const txn = await Transaction.findOne({ reference });
        if (!txn) {
            console.log('Transaction not found:', reference);
        } else {
            console.log('Transaction details:', JSON.stringify(txn, null, 2));
        }

        // Also check any recent transactions in general
        const recentTxns = await Transaction.find().sort({ createdAt: -1 }).limit(5);
        console.log('Recent 5 transactions:', JSON.stringify(recentTxns, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
