import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from './src/models/User';
import { AcademicYear } from './src/models/AcademicYear';
import { FeeType } from './src/models/FeeType';
import { StudentFee } from './src/models/StudentFee';
import { FeeItem } from './src/models/FeeItem';
import { config } from './src/config/env';

// Force model registration
const _models = [User, AcademicYear, FeeType, StudentFee, FeeItem];

const verify = async () => {
    try {
        console.log('🔌 Connecting to DB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected.');

        const students = await User.find({ role: 'student' });
        console.log(`\n👤 Found ${students.length} students:`);

        for (const s of students) {
            console.log(`\n--------------------------------------------------`);
            console.log(`Student: ${s.firstName} ${s.lastName} (${s.email})`);
            console.log(`Programme: ${s.programme} (programmeRef: ${s.programmeRef})`);

            const sFees = await StudentFee.find({ student: s._id }).populate('academicYear');
            console.log(`  StudentFee Records (${sFees.length}):`);
            sFees.forEach(sf => {
                const year = (sf.academicYear as any)?.yearLabel || 'N/A';
                console.log(`    - Semester ${sf.semester} (${year}): Total GH¢ ${sf.totalFee}, Paid GH¢ ${sf.amountPaid}, Balance GH¢ ${sf.balance}, Status: ${sf.status}`);
            });

            const items = await FeeItem.find({ studentId: s._id }).populate('feeTypeId');
            console.log(`  FeeItem Records (${items.length}):`);
            items.forEach(fi => {
                const ft = fi.feeTypeId as any;
                console.log(`    - ${ft ? ft.name : 'Unknown'} (Sem ${fi.semester}): Total GH¢ ${fi.totalAmount}, Paid GH¢ ${fi.amountPaid}, Balance GH¢ ${fi.balance}, Status: ${fi.status}`);
            });
        }

        console.log(`\n--------------------------------------------------`);
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Verification failed:', err);
        process.exit(1);
    }
};

verify();
