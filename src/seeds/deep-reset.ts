import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { AcademicYear } from '../models/AcademicYear';
import { Programme } from '../models/Programme';
import { Faculty } from '../models/Faculty';
import { FeeTemplate } from '../models/FeeTemplate';
import { StudentFee } from '../models/StudentFee';
import { FeeItem } from '../models/FeeItem';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { FeeCalculationService } from '../services/feeCalculationService';

// Force all models to register
const _models = [User, AcademicYear, Programme, Faculty, FeeTemplate, StudentFee, FeeItem, Payment, Transaction];

const runDeepReset = async () => {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) { console.error('❌ MONGODB_URI missing'); process.exit(1); }

        console.log('🌱 Connecting to MongoDB Atlas...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected.\n');

        // Step 1: DELETE all StudentFee records (so they get recreated fresh)
        const sfDelResult = await StudentFee.deleteMany({});
        console.log(`🗑️  Deleted ${sfDelResult.deletedCount} StudentFee records.`);

        // Step 2: DELETE all FeeItem records
        const fiDelResult = await FeeItem.deleteMany({});
        console.log(`🗑️  Deleted ${fiDelResult.deletedCount} FeeItem records.`);

        // Step 3: DELETE all Payments and Transactions
        const payDel = await Payment.deleteMany({});
        const transDel = await Transaction.deleteMany({});
        console.log(`🗑️  Deleted ${payDel.deletedCount} Payments, ${transDel.deletedCount} Transactions.\n`);

        // Step 4: Recreate fees fresh for all students using corrected templates
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        if (!activeYear) { console.warn('⚠️ No active academic year — stopping.'); process.exit(1); }
        console.log(`📅 Active Year: ${activeYear.yearLabel}`);

        const students = await User.find({ role: 'student' });
        console.log(`👤 Found ${students.length} students. Recreating fees...\n`);

        let success = 0;
        const errors: string[] = [];

        for (const student of students) {
            try {
                // Create Semester 1
                const sf1 = await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                // Create Semester 2
                const sf2 = await FeeCalculationService.getOrCreateStudentFee(student as any, 2);
                // Assign global fee items (hostel, exams, etc.)
                await FeeCalculationService.assignApplicableGlobalFees(student as any);

                if (sf1 && sf2) {
                    console.log(`   ✨ ${student.firstName} ${student.lastName}:`);
                    console.log(`      Sem 1: GH¢ ${sf1.totalFee} | Sem 2: GH¢ ${sf2.totalFee}`);
                    success++;
                }
            } catch (e: any) {
                const msg = `${student.firstName} ${student.lastName}: ${e.message}`;
                errors.push(msg);
                console.error(`   ❌ ${msg}`);
            }
        }

        console.log(`\n✅ Successfully created fees for ${success}/${students.length} students.`);
        if (errors.length > 0) {
            console.log(`⚠️  Errors (${errors.length}):`);
            errors.forEach(e => console.log(`   - ${e}`));
        }

        console.log('\n🎉 Deep reset complete!');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err);
        process.exit(1);
    }
};

runDeepReset();
