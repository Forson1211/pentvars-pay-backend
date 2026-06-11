import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { AcademicYear } from './src/models/AcademicYear';
import { Programme } from './src/models/Programme';
import { FeeTemplate } from './src/models/FeeTemplate';
import { config } from './src/config/env';

const run = async () => {
    await mongoose.connect(config.mongoURI);
    console.log('Connected.');

    const activeYear = await AcademicYear.findOne({ isActive: true });
    console.log('Active Year:', activeYear ? activeYear.yearLabel : 'NONE');

    const programmes = await Programme.find({});
    console.log('--- ALL PROGRAMMES ---');
    for (const p of programmes) {
        console.log(`ID: ${p._id}, Name: ${p.programmeName}`);
    }

    if (activeYear) {
        const templates = await FeeTemplate.find({ academicYear: activeYear._id });
        console.log(`--- TEMPLATES FOR ACTIVE YEAR (${activeYear.yearLabel}) count: ${templates.length} ---`);
        for (const t of templates.slice(0, 10)) {
            const prog = await Programme.findById(t.programme);
            console.log(`Template ID: ${t._id}, Level: ${t.level}, Stream: ${t.studentType}, Prog: ${prog ? prog.programmeName : 'N/A'}`);
        }
    }

    await mongoose.disconnect();
};

run();
