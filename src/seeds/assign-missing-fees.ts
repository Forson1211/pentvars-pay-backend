import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { FeeType } from '../models/FeeType';
import { FeeItem } from '../models/FeeItem';
import { config } from '../config/env';

const assignMissingFeesToExistingStudents = async () => {
    try {
        console.log('🌱 Connecting to MongoDB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected to MongoDB');

        const students = await User.find({ role: 'student' });
        const activeFeeTypes = await FeeType.find({ isActive: true });

        console.log(`📊 Found ${students.length} students and ${activeFeeTypes.length} active fee types.`);

        for (const student of students) {
            console.log(`👤 Processing student: ${student.firstName} ${student.lastName}`);
            for (const feeType of activeFeeTypes) {
                // Check if student already has this fee type
                const existingFee = await FeeItem.findOne({
                    studentId: student._id,
                    feeTypeId: feeType._id,
                    academicYear: feeType.academicYear,
                    semester: feeType.semester
                });

                if (!existingFee) {
                    console.log(`   ➕ Assigning fee: ${feeType.name} (${feeType.amount})`);
                    await FeeItem.create({
                        feeTypeId: feeType._id,
                        studentId: student._id,
                        totalAmount: feeType.amount,
                        amountPaid: 0,
                        balance: feeType.amount,
                        status: 'pending',
                        dueDate: feeType.dueDate,
                        academicYear: feeType.academicYear,
                        semester: feeType.semester,
                    });
                } else {
                    console.log(`   ✅ Fee already assigned: ${feeType.name}`);
                }
            }
        }

        console.log('🚀 Finished assigning missing fees.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error assigning fees:', error);
        process.exit(1);
    }
};

assignMissingFeesToExistingStudents();
