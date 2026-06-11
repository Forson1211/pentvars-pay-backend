import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from './src/models/User';
import { AcademicYear } from './src/models/AcademicYear';
import { FeeType } from './src/models/FeeType';
import { StudentFee } from './src/models/StudentFee';
import { FeeTemplate } from './src/models/FeeTemplate';
import { FeeItem } from './src/models/FeeItem';
import { FeeCalculationService } from './src/services/feeCalculationService';
import { config } from './src/config/env';

// Force model registration
const _models = [User, AcademicYear, FeeType, StudentFee, FeeItem, FeeTemplate];

const run = async () => {
    try {
        console.log('🔌 Connecting to DB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected.');

        const studentFees = await StudentFee.find().populate('feeTemplate');
        console.log(`\n📄 Found ${studentFees.length} student fee records to recalculate...`);

        let count = 0;
        for (const sf of studentFees) {
            if (!sf.feeTemplate) {
                console.log(`⚠️ Skipped record ${sf._id} because it has no feeTemplate`);
                continue;
            }
            
            console.log(`Recalculating fee for student ${sf.student} (Semester ${sf.semester})...`);
            await FeeCalculationService.recalculateStudentFee(sf._id, sf.feeTemplate as any);
            count++;
        }

        console.log(`\n🎉 Successfully recalculated ${count} student fee records.`);
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
};

run();
