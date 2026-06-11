import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const db = mongoose.connection.db;
        if (!db) {
            console.error('No database connection');
            return;
        }

        console.log('--- RAW TEMPLATES ---');
        const templates = await db.collection('feetemplates').find().toArray();
        for (const t of templates) {
            console.log(`Template ID: ${t._id}, Level: ${t.level}, StudentType: ${t.studentType}`);
            console.log(`  tuitionPerSemester: ${t.tuitionPerSemester}`);
            console.log(`  academicUserFee: ${t.academicUserFee}`);
            console.log(`  srcFee: ${t.srcFee}`);
            console.log(`  practicalFee: ${t.practicalFee}`);
        }

        console.log('\n--- RAW STUDENT FEES ---');
        const fees = await db.collection('studentfees').find().toArray();
        for (const f of fees) {
            console.log(`StudentFee ID: ${f._id}, Student: ${f.student}, Semester: ${f.semester}`);
            console.log(`  totalFee: ${f.totalFee}`);
            console.log(`  breakdown:`, JSON.stringify(f.breakdown));
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
};

run();
