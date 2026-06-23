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

const FACULTIES = [
    { name: 'Faculty of Business Administration', code: 'FBA' },
    { name: 'Faculty of Engineering, Science & Computing', code: 'FESAC' },
    { name: 'Faculty of Health & Allied Sciences', code: 'FHAS' },
    { name: 'Faculty of Law', code: 'FLAW' },
    { name: 'Faculty of Education', code: 'FEDU' },
    { name: 'Pentecost School of Theology & Missions', code: 'PSTM' },
];

const PROGRAMMES_MAP: Record<string, { programmeName: string; code: string }[]> = {
    FBA: [
        { programmeName: 'Accounting', code: 'BAC' },
        { programmeName: 'Banking & Finance', code: 'BBF' },
        { programmeName: 'Business Administration / Commerce', code: 'BCOM' },
        { programmeName: 'Human Resource Management', code: 'BHR' },
        { programmeName: 'Marketing', code: 'BMK' },
        { programmeName: 'Logistics & Supply Chain Management', code: 'BA-LOG' },
    ],
    FESAC: [
        { programmeName: 'Information Technology', code: 'BIT' },
        { programmeName: 'Industrial Software Engineering', code: 'BISE' },
        { programmeName: 'Applied Science', code: 'BAS' },
        { programmeName: 'Computer Science', code: 'BCS' },
        { programmeName: 'Computer Technology Engineering', code: 'BCTE' },
        { programmeName: 'Electrical & Electronic Engineering', code: 'BEEEE' },
        { programmeName: 'Architecture / Built Environment', code: 'BERA' },
        { programmeName: 'Quantity Surveying & Construction', code: 'BQSC' },
        { programmeName: 'BEng Programmes', code: 'BENG' },
        { programmeName: 'Built Environment Programmes', code: 'BEP' },
    ],
    FHAS: [
        { programmeName: 'Health Information Management', code: 'BHIM' },
        { programmeName: 'Nursing', code: 'BNS' },
        { programmeName: 'Midwifery', code: 'BMWF' },
        { programmeName: 'Physician Assistantship', code: 'PA' },
        { programmeName: 'Doctor of Herbal Medicine', code: 'DHMD' },
    ],
    FLAW: [
        { programmeName: 'Law', code: 'BLAW' },
        { programmeName: 'Legal Studies', code: 'BLSC' },
    ],
    FEDU: [
        { programmeName: 'Education Programmes', code: 'EDUP' },
    ],
    PSTM: [
        { programmeName: 'Theology Programmes', code: 'THEO' },
        { programmeName: 'Missions Programmes', code: 'MISS' },
    ],
};

function getTemplateParams(facultyCode: string, programmeCode: string, level: string) {
    let tuition = 2500;
    let practicalFee = 0;
    let cipsFee = 0;
    const isL100 = level === '100';

    if (facultyCode === 'FBA') {
        if (programmeCode === 'BA-LOG') {
            tuition = 2750;
            cipsFee = 800;
        } else {
            tuition = 2783;
        }
    } else if (facultyCode === 'FESAC') {
        if (['BERA', 'BQSC', 'BEP'].includes(programmeCode)) {
            tuition = 2783;
            practicalFee = 800;
        } else {
            tuition = 2553;
        }
    } else if (facultyCode === 'FHAS') {
        if (['BNS', 'BMWF', 'PA'].includes(programmeCode)) {
            tuition = isL100 ? 3420 : 4400;
            practicalFee = 900;
        } else if (programmeCode === 'DHMD') {
            tuition = isL100 ? 3974 : 5500;
            practicalFee = 1000;
        } else { // BHIM
            tuition = 3420;
            practicalFee = 900;
        }
    } else if (facultyCode === 'FLAW') {
        tuition = 2750;
        practicalFee = 900;
    } else if (facultyCode === 'PSTM') {
        tuition = 2553;
    } else if (facultyCode === 'FEDU') {
        tuition = 2500;
    }

    return {
        tuitionPerSemester: tuition,
        academicUserFee: 492, // Annual
        srcFee: 50, // Annual
        practicalFee,
        cipsFee,
        latePenalty: 100,
        scholarshipDiscount: 0,
    };
}

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
        for (const [code, progs] of Object.entries(PROGRAMMES_MAP)) {
            const fac = facCodeMap[code];
            if (!fac) continue;
            for (const progData of progs) {
                const prog = await Programme.findOneAndUpdate(
                    { faculty: fac._id, code: progData.code },
                    { faculty: fac._id, programmeName: progData.programmeName, code: progData.code },
                    { upsert: true, new: true }
                );
                progMap[progData.programmeName] = prog;
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
        const forsonProg = progMap['Information Technology'];
        if (!forson) {
            forson = await User.create({
                email: 'puit22217120@pentvars.edu.gh', password: '370563Forson',
                firstName: 'Forson', lastName: 'Odonkor', role: 'student', studentId: 'PUIT/22217120',
                programme: 'Information Technology', level: '400', currentLevel: 400,
                graduationLevel: 400, entryLevel: 100, status: 'active',
                stream: 'regular', nationality: 'ghanaian',
                programmeRef: forsonProg?._id,
            });
        } else {
            forson.password = '370563Forson';
            forson.currentLevel = 400;
            forson.graduationLevel = 400;
            forson.programme = 'Information Technology';
            forson.programmeRef = forsonProg?._id || forson.programmeRef;
            await forson.save();
        }

        console.log('💸 Generating All Original Fee Templates...');
        const levels = ['100', '200', '300', '400'];
        const studentTypes = ['regular', 'weekend', 'international'];
        const multipliers = { regular: 1.0, weekend: 1.1, international: 1.5 };

        for (const fac of faculties) {
            const progs = await Programme.find({ faculty: fac._id });
            for (const prog of progs) {
                for (const level of levels) {
                    const baseParams = getTemplateParams(fac.code!, prog.code!, level);
                    for (const studentType of studentTypes) {
                        const multiplier = multipliers[studentType as keyof typeof multipliers];
                        await FeeTemplate.create({
                            academicYear: academicYear._id,
                            studentType,
                            faculty: fac._id,
                            programme: prog._id,
                            level,
                            tuitionPerSemester: Math.round(baseParams.tuitionPerSemester * multiplier),
                            sem2TuitionPerSemester: Math.round(baseParams.tuitionPerSemester * multiplier),
                            academicUserFee: baseParams.academicUserFee,
                            srcFee: baseParams.srcFee,
                            practicalFee: baseParams.practicalFee,
                            cipsFee: baseParams.cipsFee,
                            latePenalty: baseParams.latePenalty,
                            scholarshipDiscount: baseParams.scholarshipDiscount,
                            installmentAllowed: true,
                            maxInstallments: 3,
                            isActive: true,
                            createdBy: admin._id
                        });
                    }
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
            faculty: facCodeMap['FESAC']?._id, programme: progMap['Information Technology']?._id,
            level: '400', studentType: 'regular'
        });

        if (forsonTemplate) {
            await StudentFee.create({
                student: forson._id, academicYear: academicYear._id, feeTemplate: forsonTemplate._id, semester: 1,
                totalFee: 3271.00, amountPaid: 0.01, balance: 3270.99, status: 'partial', dueDate: new Date('2027-05-30'),
                breakdown: { tuition: 3000.00, srcFee: 25.00, academicUserFee: 246.00, practicalFee: 0, cipsFee: 0, latePenalty: 0, scholarshipDiscount: 0 }
            });
        }

        const generalTypes = [hostelType, supplementaryType, resitType];
        for (const type of generalTypes) {
            await FeeItem.create({
                feeTypeId: type._id, studentId: forson._id, totalAmount: type.amount,
                amountPaid: 0, balance: type.amount, status: 'pending',
                dueDate: type.dueDate, academicYear: type.academicYear, semester: type.semester,
            });
        }

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
        console.log('✅ Payment history added.');

        console.log('\n✅ DATABASE EXACTLY REPLICATED TO MATCH SCREENSHOT!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Sync Error:', error);
        process.exit(1);
    }
};

seedDatabase();
