import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from './src/models/User';
import { FeeTemplate } from './src/models/FeeTemplate';
import { StudentFee } from './src/models/StudentFee';
import { Programme } from './src/models/Programme';
import { config } from './src/config/env';

// Force model registration
const _models = [User, FeeTemplate, StudentFee, Programme];

const run = async () => {
    await mongoose.connect(config.mongoURI);
    console.log('✅ Connected.');

    const students = await User.find({ role: 'student' });
    for (const student of students) {
        console.log(`\n==================================================`);
        console.log(`Student: ${student.firstName} ${student.lastName}`);
        console.log(`Programme: ${student.programme} (Ref: ${student.programmeRef})`);
        console.log(`Level: ${student.level || '100'} (currentLevel: ${student.currentLevel})`);
        console.log(`Stream: ${student.stream}, Nationality: ${student.nationality}`);

        // Find StudentFee records
        const fees = await StudentFee.find({ student: student._id }).populate({
            path: 'feeTemplate',
            populate: { path: 'programme' }
        });
        
        console.log(`Fees Generated:`);
        for (const sf of fees) {
            const template = sf.feeTemplate as any;
            console.log(`  - Semester ${sf.semester}: Total GH¢ ${sf.totalFee}`);
            if (template) {
                console.log(`    Template ID: ${template._id}`);
                console.log(`    Template Programme: ${template.programme?.programmeName} (Ref: ${template.programme?._id || template.programme})`);
                console.log(`    Template Level: ${template.level}, Stream: ${template.studentType}`);
                console.log(`    Template Details: Tuition GH¢ ${template.tuitionPerSemester}, User GH¢ ${template.academicUserFee}, SRC GH¢ ${template.srcFee}, Practical GH¢ ${template.practicalFee}`);
            } else {
                console.log(`    ⚠️ No template associated with this StudentFee record!`);
            }
        }

        // Try resolving template dynamically
        const stream = student.stream || 'regular';
        const level = student.level || '100';
        const resolvedLevel = student.currentLevel ? student.currentLevel.toString() : level;
        const matchingTemplate = await FeeTemplate.findOne({
            studentType: stream,
            programme: student.programmeRef,
            level: resolvedLevel,
            isActive: true
        }).populate('programme');

        console.log(`Matching Template in DB:`);
        if (matchingTemplate) {
            console.log(`  ID: ${matchingTemplate._id}`);
            console.log(`  Programme: ${(matchingTemplate.programme as any)?.programmeName}`);
            console.log(`  Level: ${matchingTemplate.level}, Stream: ${matchingTemplate.studentType}`);
            console.log(`  Tuition GH¢ ${matchingTemplate.tuitionPerSemester}, User GH¢ ${matchingTemplate.academicUserFee}, SRC GH¢ ${matchingTemplate.srcFee}, Practical GH¢ ${matchingTemplate.practicalFee}`);
        } else {
            console.log(`  ❌ No matching template found in DB!`);
        }
    }

    await mongoose.disconnect();
};

run();
