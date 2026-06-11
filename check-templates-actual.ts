import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from './src/models/User';
import { AcademicYear } from './src/models/AcademicYear';
import { Faculty } from './src/models/Faculty';
import { Programme } from './src/models/Programme';
import { FeeTemplate } from './src/models/FeeTemplate';
import { FeeType } from './src/models/FeeType';
import { StudentFee } from './src/models/StudentFee';
import { FeeItem } from './src/models/FeeItem';
import { config } from './src/config/env';

// Register all models
const _models = [User, AcademicYear, Faculty, Programme, FeeTemplate, FeeType, StudentFee, FeeItem];

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('Connected to MongoDB.');

        const templates = await FeeTemplate.find({}).populate('programme').populate('faculty').populate('academicYear');
        console.log(`Found ${templates.length} templates:`);
        for (const t of templates) {
            console.log(`\nTemplate ID: ${t._id}`);
            console.log(`Academic Year: ${(t.academicYear as any)?.yearLabel || t.academicYear}`);
            console.log(`Programme: ${(t.programme as any)?.programmeName || t.programme}`);
            console.log(`Student Type: ${t.studentType}`);
            console.log(`Level: ${t.level}`);
            console.log(`Tuition: ${t.tuitionPerSemester}`);
            console.log(`SRC Fee: ${t.srcFee}`);
            console.log(`Academic User Fee: ${t.academicUserFee}`);
            console.log(`Practical Fee: ${t.practicalFee}`);
            console.log(`CIPS Fee: ${t.cipsFee}`);
            console.log(`Active: ${t.isActive}`);
        }
        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
