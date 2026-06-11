import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from './src/models/User';
import { StudentFee } from './src/models/StudentFee';
import { FeeTemplate } from './src/models/FeeTemplate';
import { AcademicYear } from './src/models/AcademicYear';
import { config } from './src/config/env';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const student = await User.findOne({ email: 'puit22217120@pentvars.edu.gh' });
        if (!student) {
            console.log('Student not found');
            return;
        }

        const fees = await StudentFee.find({ student: student._id }).populate('feeTemplate');
        console.log(`Student: ${student.firstName} ${student.lastName}`);
        for (const sf of fees) {
            console.log(`\nSemester ${sf.semester}:`);
            console.log(`StudentFee ID: ${sf._id}`);
            console.log(`TotalFee: ${sf.totalFee}`);
            console.log(`Breakdown:`, JSON.stringify(sf.breakdown));
            
            const template = sf.feeTemplate as any;
            if (template) {
                console.log(`Matching Template ID: ${template._id}`);
                console.log(`Template tuitionPerSemester: ${template.tuitionPerSemester}`);
                console.log(`Template academicUserFee: ${template.academicUserFee}`);
                console.log(`Template srcFee: ${template.srcFee}`);
                console.log(`Template practicalFee: ${template.practicalFee}`);
            }
        }
        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
