import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Faculty } from './src/models/Faculty';
import { config } from './src/config/env';

const run = async () => {
    await mongoose.connect(config.mongoURI);
    const faculties = await Faculty.find({});
    console.log('--- Faculties in DB ---');
    faculties.forEach(f => {
        console.log(`ID: ${f._id}, Name: ${f.name}, Code: ${f.code}`);
    });
    await mongoose.disconnect();
};

run();
