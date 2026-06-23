import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Programme } from './src/models/Programme';
import { User } from './src/models/User';
import { config } from './src/config/env';

const run = async () => {
    try {
        console.log('🌱 Connecting to database...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected to MongoDB.');

        // 1. Rename programme document
        const prog = await Programme.findOne({ code: 'BISE' });
        if (prog) {
            console.log(`🎓 Found programme. Current name: "${prog.programmeName}"`);
            prog.programmeName = 'Industrial Software Engineering';
            await prog.save();
            console.log(`✅ Renamed programme to "Industrial Software Engineering"`);
        } else {
            console.log('⚠️ Programme with code "BISE" not found.');
        }

        // 2. Rename programme in user records
        const updateUsersResult = await User.updateMany(
            { programme: 'Information Systems Engineering' },
            { $set: { programme: 'Industrial Software Engineering' } }
        );
        console.log(`✅ Updated ${updateUsersResult.modifiedCount} user records.`);

        await mongoose.disconnect();
        console.log('🔌 Disconnected.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
};

run();
