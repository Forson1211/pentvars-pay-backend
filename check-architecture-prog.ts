import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Programme } from './src/models/Programme';
import { Faculty } from './src/models/Faculty';
import { config } from './src/config/env';

// Force model registration
const _models = [Programme, Faculty];

const run = async () => {
    await mongoose.connect(config.mongoURI);
    console.log('✅ Connected.');

    const prog = await Programme.findOne({ programmeName: 'BSc. Architecture' }).populate('faculty');
    if (prog) {
        console.log('Programme Details:');
        console.log(`  ID: ${prog._id}`);
        console.log(`  Name: ${prog.programmeName}`);
        console.log(`  Faculty Ref: ${prog.faculty}`);
        console.log(`  Faculty Object:`, JSON.stringify(prog.faculty, null, 2));
    } else {
        console.log('❌ BSc. Architecture not found!');
    }

    await mongoose.disconnect();
};

run();
