import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { AcademicYear } from './src/models/AcademicYear';
import { config } from './src/config/env';

async function check() {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('Connected to:', config.mongoURI);

        const years = await AcademicYear.find({}).lean();
        console.log('--- Academic Years ---');
        years.forEach(y => {
            console.log(`Label: "${y.yearLabel}", id: "${y._id.toString()}", isActive: ${y.isActive}`);
        });

        const template = await FeeTemplate.findOne({}).lean();
        if (template) {
            console.log('\n--- Sample Fee Template ---');
            console.log('academicYear (raw ID):', (template as any).academicYear?.toString());
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

check();
