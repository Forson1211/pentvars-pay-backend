import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { StudentFee } from '../models/StudentFee';
import { FeeItem } from '../models/FeeItem';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { FeeCalculationService } from '../services/feeCalculationService';

const runReset = async () => {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error('❌ MONGODB_URI is not defined in .env');
            process.exit(1);
        }

        console.log('🌱 Connecting to live MongoDB Atlas database...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB.');

        // ── Step 1: Reset StudentFee records ───────────────────────────
        console.log('🔄 Resetting StudentFee records...');
        const studentFees = await StudentFee.find({});
        let sfReset = 0;
        for (const sf of studentFees) {
            sf.amountPaid = 0;
            sf.balance = sf.totalFee;
            sf.status = 'unpaid';
            await sf.save();
            sfReset++;
        }
        console.log(`✅ Reset ${sfReset} StudentFee records.`);

        // ── Step 2: Reset FeeItem records ─────────────────────────────
        console.log('🔄 Resetting FeeItem records...');
        const feeItems = await FeeItem.find({});
        let fiReset = 0;
        for (const fi of feeItems) {
            fi.amountPaid = 0;
            fi.balance = fi.totalAmount;
            fi.status = 'pending';
            await fi.save();
            fiReset++;
        }
        console.log(`✅ Reset ${fiReset} FeeItem records.`);

        // ── Step 3: Delete Payments and Transactions ──────────────────
        console.log('🗑️ Deleting all payment and transaction records...');
        const payDel = await Payment.deleteMany({});
        const transDel = await Transaction.deleteMany({});
        console.log(`✅ Deleted ${payDel.deletedCount} Payment records.`);
        console.log(`✅ Deleted ${transDel.deletedCount} Transaction records.`);

        // ── Step 4: Auto-create missing student fees ──────────────────
        console.log('🔄 Verifying active student fee records...');
        const activeYear = await FeeCalculationService.getActiveAcademicYear();
        if (!activeYear) {
            console.warn('⚠️ No active academic year found. Skipping fee generation.');
        } else {
            console.log(`📅 Active academic year: ${activeYear.yearLabel}`);
            const allStudents = await User.find({ role: 'student' });
            console.log(`👤 Found ${allStudents.length} students. Checking fee coverages...`);

            let autoCreated = 0;
            for (const student of allStudents) {
                try {
                    let created = false;
                    const sem1Fee = await StudentFee.findOne({ student: student._id, academicYear: activeYear._id, semester: 1 });
                    if (!sem1Fee) {
                        await FeeCalculationService.getOrCreateStudentFee(student as any, 1);
                        created = true;
                    }
                    const sem2Fee = await StudentFee.findOne({ student: student._id, academicYear: activeYear._id, semester: 2 });
                    if (!sem2Fee) {
                        await FeeCalculationService.getOrCreateStudentFee(student as any, 2);
                        created = true;
                    }
                    // Always refresh global fees
                    const assignedCount = await FeeCalculationService.assignApplicableGlobalFees(student as any);
                    if (created || assignedCount > 0) {
                        autoCreated++;
                        console.log(`   ✨ Generated fees for: ${student.firstName} ${student.lastName}`);
                    }
                } catch (e: any) {
                    console.error(`   ❌ Failed for ${student.firstName} ${student.lastName}:`, e.message);
                }
            }
            console.log(`✅ Completed checking student fee records. Updates applied to ${autoCreated} students.`);
        }

        console.log('🎉 Reset process completed successfully!');
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error executing database reset:', error);
        process.exit(1);
    }
};

runReset();
