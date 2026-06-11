import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { AcademicYear } from './src/models/AcademicYear';
import { config } from './src/config/env';

// Force model registration
const _models = [FeeTemplate, AcademicYear];

const run = async () => {
    await mongoose.connect(config.mongoURI);
    console.log('✅ Connected.');

    const activeYear = await AcademicYear.findOne({ isActive: true });
    if (!activeYear) { console.log('❌ No active academic year'); process.exit(1); }
    console.log(`📅 Active Year: ${activeYear.yearLabel}`);

    // Find all templates where academicUserFee=0 AND srcFee=0 (broken ones)
    const brokenTemplates = await FeeTemplate.find({
        academicYear: activeYear._id,
        academicUserFee: 0,
        srcFee: 0,
    });

    console.log(`\n⚠️ Found ${brokenTemplates.length} templates with 0 userFee/srcFee.`);

    let fixed = 0;
    for (const t of brokenTemplates) {
        t.academicUserFee = 492;
        t.srcFee = 50;
        await t.save();
        fixed++;
    }

    console.log(`✅ Fixed ${fixed} templates.`);

    // Verify: count remaining broken templates
    const remaining = await FeeTemplate.countDocuments({
        academicYear: activeYear._id,
        academicUserFee: 0,
        srcFee: 0,
    });
    console.log(`✅ Remaining broken templates: ${remaining}`);

    // Sample check
    const sample = await FeeTemplate.find({ academicYear: activeYear._id, studentType: 'regular' })
        .limit(5).lean();
    console.log('\nSample regular templates after fix:');
    sample.forEach(t => {
        console.log(`  Level ${t.level}: Tuition=${t.tuitionPerSemester}, UserFee=${t.academicUserFee}, SRC=${t.srcFee}`);
    });

    await mongoose.disconnect();
    console.log('\n🎉 Done!');
};

run();
