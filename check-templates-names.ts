import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { Programme } from './src/models/Programme';
import { config } from './src/config/env';

const run = async () => {
    await mongoose.connect(config.mongoURI);
    const templates = await FeeTemplate.find({});
    const names = new Set();
    for (const t of templates) {
        const prog = await Programme.findById(t.programme);
        names.add(prog ? prog.programmeName : 'N/A');
    }
    console.log('--- FeeTemplate Programme Names ---');
    console.log(Array.from(names));
    await mongoose.disconnect();
};

run();
