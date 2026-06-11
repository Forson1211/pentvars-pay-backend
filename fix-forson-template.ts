import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { Programme } from './src/models/Programme';
import { Faculty } from './src/models/Faculty';
import { AcademicYear } from './src/models/AcademicYear';
import { config } from './src/config/env';

// Force model registration
const _models = [FeeTemplate, Programme, Faculty, AcademicYear];

const run = async () => {
    await mongoose.connect(config.mongoURI);
    console.log('✅ Connected.');

    // Find BSc. IT Level 400 regular template
    const itProg = await Programme.findOne({ programmeName: 'BSc. Information Technology' });
    if (!itProg) { console.log('❌ IT programme not found'); process.exit(1); }

    const templates = await FeeTemplate.find({ programme: itProg._id });
    console.log(`\nAll templates for BSc. IT (${templates.length} total):`);
    templates.forEach(t => {
        console.log(`  Level ${t.level}, Stream ${t.studentType}: Tuition=${t.tuitionPerSemester}, UserFee=${t.academicUserFee}, SRC=${t.srcFee}, Practical=${t.practicalFee}`);
    });

    // Find the specifically bad one
    const activeYear = await AcademicYear.findOne({ isActive: true });
    const badTemplate = await FeeTemplate.findOne({
        programme: itProg._id,
        level: '400',
        studentType: 'regular',
        academicYear: activeYear?._id
    });

    if (badTemplate) {
        console.log(`\nForson's template (Level 400 regular):`);
        console.log(`  ID: ${badTemplate._id}`);
        console.log(`  Tuition: ${badTemplate.tuitionPerSemester}`);
        console.log(`  academicUserFee: ${badTemplate.academicUserFee}`);
        console.log(`  srcFee: ${badTemplate.srcFee}`);
        console.log(`  practicalFee: ${badTemplate.practicalFee}`);

        // Fix: FESAC programmes should have tuition=2553, userFee=492, srcFee=50
        // But Level 400 tuition might still be correct if it was scaled.
        // According to seedFaculties.ts: FESAC tuition=2553 for ALL levels (no level scaling)
        const correctTuition = 2553;
        const needsFix = badTemplate.academicUserFee !== 492 || badTemplate.srcFee !== 50;
        
        if (needsFix) {
            console.log(`\n⚠️ Template has wrong userFee/srcFee. Fixing...`);
            badTemplate.academicUserFee = 492;
            badTemplate.srcFee = 50;
            badTemplate.tuitionPerSemester = correctTuition; // FESAC regular = 2553
            await badTemplate.save();
            console.log(`✅ Fixed! New values: Tuition=${badTemplate.tuitionPerSemester}, UserFee=${badTemplate.academicUserFee}, SRC=${badTemplate.srcFee}`);
        } else {
            console.log(`\n✅ Template looks correct!`);
        }
    }

    await mongoose.disconnect();
};

run();
