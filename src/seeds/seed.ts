import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { AcademicYear } from '../models/AcademicYear';
import { FeeTemplate } from '../models/FeeTemplate';
import { StudentFee } from '../models/StudentFee';
import { Payment } from '../models/Payment';
import { Transaction } from '../models/Transaction';
import { FeeType } from '../models/FeeType';
import { FeeItem } from '../models/FeeItem';
import { config } from '../config/env';

/**
 * EXACT VISUAL REPLICA SEED
 * Matches your screenshot headers, card names, and amounts perfectly.
 */

const FACULTIES = [
    { name: 'Engineering, Science & Computing (FESAC)', code: 'FESAC' },
    { name: 'Built Environment & BEng Programmes', code: 'BENV' },
    { name: 'Law', code: 'LAW' },
    { name: 'Pentecost School of Theology & Missions', code: 'PSTM' },
    { name: 'Business Administration', code: 'BA' },
    { name: 'Health and Allied Science (FEHAS)', code: 'FEHAS' },
    { name: 'Doctor of Herbal Medicine', code: 'DHM' },
    { name: 'FEHAS – Engineering Programmes', code: 'FEHAS-ENG' },
    { name: 'Nursing', code: 'NUR' },
    { name: 'Physician Assistantship', code: 'PA' },
    { name: 'Midwifery', code: 'MID' },
    { name: 'Business Administration – Logistics & Supply Chain Management', code: 'BA-LOG' },
];

const PROGRAMMES_MAP: Record<string, string[]> = {
    'FESAC': ['BSc. Information Technology', 'BSc. Computer Science', 'BSc. Computer Engineering', 'BSc. Mathematics'],
    'BENV': ['BSc. Architecture', 'BSc. Quantity Surveying', 'BSc. Construction Technology'],
};

const getTemplateParams = (facultyCode: string, level: string) => {
    const isL400 = level === '400';
    let tuition = isL400 ? 3270.99 : 2553;
    return {
        tuitionPerSemester: tuition, academicUserFee: 0, srcFee: 0, practicalFee: 0, cipsFee: 0, latePenalty: 0, scholarshipDiscount: 0,
    };
};

const seedDatabase = async () => {
    try {
        console.log('🌱 Connecting to MongoDB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected to MongoDB');

        console.log('🧹 Clearing configuration and transaction data...');
        await Promise.all([
            Faculty.deleteMany({}),
            Programme.deleteMany({}),
            AcademicYear.deleteMany({}),
            FeeTemplate.deleteMany({}),
            StudentFee.deleteMany({}),
            Payment.deleteMany({}),
            Transaction.deleteMany({}),
            FeeType.deleteMany({}),
            FeeItem.deleteMany({}),
        ]);

        const academicYear = await AcademicYear.create({
            yearLabel: '2026/2027', startDate: new Date('2026-09-01'), endDate: new Date('2027-07-31'), isActive: true,
        });

        for (const facData of FACULTIES) {
            await Faculty.findOneAndUpdate({ code: facData.code }, facData, { upsert: true, new: true });
        }
        const faculties = await Faculty.find();
        const facCodeMap: Record<string, any> = {};
        faculties.forEach(f => { facCodeMap[f.code!] = f; });

        const progMap: Record<string, any> = {};
        for (const [code, names] of Object.entries(PROGRAMMES_MAP)) {
            const fac = facCodeMap[code];
            if (!fac) continue;
            for (const name of names) {
                const prog = await Programme.findOneAndUpdate(
                    { faculty: fac._id, programmeName: name },
                    { faculty: fac._id, programmeName: name },
                    { upsert: true, new: true }
                );
                progMap[name] = prog;
            }
        }

        let admin = await User.findOne({ email: 'admin@pentvarsuniversity.edu.gh' });
        if (!admin) {
            admin = await User.create({
                email: 'admin@pentvarsuniversity.edu.gh', password: 'admin123',
                firstName: 'Admin', lastName: 'User', role: 'admin', status: 'active'
            });
        }

        let forson = await User.findOne({ email: 'puit22217120@pentvars.edu.gh' });
        const forsonProg = progMap['BSc. Information Technology'];
        if (!forson) {
            forson = await User.create({
                email: 'puit22217120@pentvars.edu.gh', password: '370563Forson',
                firstName: 'Forson', lastName: 'Odonkor', role: 'student', studentId: 'PUIT/22217120',
                programme: 'BSc. Information Technology', level: '400', currentLevel: 400,
                graduationLevel: 400, entryLevel: 100, status: 'active',
                stream: 'regular', nationality: 'ghanaian',
                programmeRef: forsonProg?._id,
            });
        } else {
            forson.password = '370563Forson';
            forson.currentLevel = 400;
            forson.graduationLevel = 400;
            forson.programmeRef = forsonProg?._id || forson.programmeRef;
            await forson.save();
        }

        console.log('💸 Generating All Original Fee Templates...');
        const levels = ['100', '200', '300', '400'];
        for (const fac of faculties) {
            const progs = await Programme.find({ faculty: fac._id });
            for (const prog of progs) {
                for (const level of levels) {
                    const params = getTemplateParams(fac.code!, level);
                    await FeeTemplate.create({
                        academicYear: academicYear._id, studentType: 'regular',
                        faculty: fac._id, programme: prog._id, level, ...params,
                        isActive: true, createdBy: admin._id
                    });
                }
            }
        }

        console.log('📄 Creating specific general fee types...');
        const hostelType = await FeeType.create({
            name: 'Hostel Fee 2026/2027', category: 'hostel', amount: 2000.00,
            academicYear: '2026/2027', semester: '1', dueDate: new Date('2027-05-30'), isActive: true
        });

        const supplementaryType = await FeeType.create({
            name: 'Supplementary Exam Fee', category: 'supplementary', amount: 299.99,
            academicYear: '2026/2027', semester: '1', dueDate: new Date('2027-05-30'), isActive: true
        });

        const resitType = await FeeType.create({
            name: 'Resit Exam Fee 2026/2027', category: 'resit', amount: 150.00,
            academicYear: '2026/2027', semester: '1', dueDate: new Date('2027-05-30'), isActive: true
        });

        console.log('🔗 Replicating exact fees for Forson Odonkor...');
        const forsonTemplate = await FeeTemplate.findOne({ 
            faculty: facCodeMap['FESAC']?._id, programme: progMap['BSc. Information Technology']?._id,
            level: '400', studentType: 'regular'
        });

        if (forsonTemplate) {
            await StudentFee.create({
                student: forson._id, academicYear: academicYear._id, feeTemplate: forsonTemplate._id, semester: 1,
                totalFee: 3271.00, amountPaid: 0.01, balance: 3270.99, status: 'partial', dueDate: new Date('2027-05-30'),
                breakdown: { tuition: 3000.00, srcFee: 25.00, academicUserFee: 246.00, practicalFee: 0, cipsFee: 0, latePenalty: 0, scholarshipDiscount: 0 }
            });
        }

        // ASSIGN ALL THREE GENERAL FEES (HOSTEL, SUPPLEMENTARY, RESIT)
        const generalTypes = [hostelType, supplementaryType, resitType];
        for (const type of generalTypes) {
            await FeeItem.create({
                feeTypeId: type._id, studentId: forson._id, totalAmount: type.amount,
                amountPaid: 0, balance: type.amount, status: 'pending',
                dueDate: type.dueDate, academicYear: type.academicYear, semester: type.semester,
            });
        }

        // SEED PAYMENT HISTORY for analytics chart (last 12 months)
        console.log('📊 Adding payment history for analytics...');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const paymentAmounts = [1200, 980, 1540, 2100, 875, 1650, 2300, 1900, 1100, 2450, 1800, 1350];
        const today = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 15);
            const amount = paymentAmounts[i % paymentAmounts.length];
            await Payment.create({
                student: forson._id,
                amount,
                paymentMethod: 'mobile_money',
                status: 'completed',
                transactionReference: `HIST-${i}-${Date.now()}`,
                paymentDate: d,
                description: `Academic fee payment - ${months[d.getMonth()]} ${d.getFullYear()}`,
            });
        }
        console.log('✅ Payment history added (12 months of data).');

        console.log('\n✅ DATABASE EXACTLY REPLICATED TO MATCH SCREENSHOT!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Sync Error:', error);
        process.exit(1);
    }
};

seedDatabase();
