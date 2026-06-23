import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { config } from '../config/env';

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
        academicUserFee: 492,
        srcFee: 50,
        practicalFee,
        cipsFee,
        latePenalty: 100,
        scholarshipDiscount: 0,
    };
}

const STUDENT_TYPES = ['regular', 'weekend', 'international'] as const;
const LEVELS = ['100', '200', '300', '400'];
const MULTIPLIERS = { regular: 1.0, weekend: 1.1, international: 1.5 };

async function repairProgrammesAndTemplates() {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('\n🔌 Connected to MongoDB\n');

        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
        if (!activeYear) throw new Error('No active academic year found!');
        console.log(`📅 Active Year: ${activeYear.yearLabel} (${activeYear._id})\n`);

        console.log('🎓 Checking / Creating Programmes...');
        let programmesCreated = 0;
        let programmesSkipped = 0;
        const progMap: Record<string, any> = {};

        for (const [facultyCode, progs] of Object.entries(PROGRAMMES_MAP)) {
            const faculty = await Faculty.findOne({ code: facultyCode }).lean();
            if (!faculty) {
                console.log(`   ⚠️  Faculty "${facultyCode}" not found in DB — skipping`);
                continue;
            }

            for (const progData of progs) {
                let existing = await Programme.findOne({
                    faculty: faculty._id,
                    code: progData.code,
                });

                if (existing) {
                    existing.programmeName = progData.programmeName;
                    existing.isActive = true;
                    await Programme.findByIdAndUpdate(existing._id, { $set: { programmeName: progData.programmeName, isActive: true } });
                    programmesSkipped++;
                    progMap[progData.programmeName] = existing;
                    continue;
                }

                const newProg = await Programme.create({
                    faculty: faculty._id,
                    programmeName: progData.programmeName,
                    code: progData.code,
                    isActive: true,
                });
                programmesCreated++;
                progMap[progData.programmeName] = newProg;
                console.log(`   ✅ Created: [${facultyCode}] ${progData.programmeName}`);
            }
        }

        const totalProgrammes = await Programme.countDocuments({ isActive: true });
        console.log(`\n   Programmes created: ${programmesCreated}, skipped: ${programmesSkipped}`);
        console.log(`   Total active programmes in DB: ${totalProgrammes}\n`);

        console.log('💰 Creating/updating fee templates...\n');

        let templatesCreated = 0;
        let templatesSkipped = 0;
        let templatesError = 0;

        const allProgrammes = await Programme.find({ isActive: true }).populate('faculty').lean();

        for (const prog of allProgrammes) {
            const fac = prog.faculty as any;
            if (!fac || !fac.code) continue;

            for (const level of LEVELS) {
                const baseParams = getTemplateParams(fac.code, prog.code || '', level);

                for (const studentType of STUDENT_TYPES) {
                    const multiplier = MULTIPLIERS[studentType];
                    const adjustedTuition = Math.round(baseParams.tuitionPerSemester * multiplier);

                    const query = {
                        academicYear: activeYear._id,
                        studentType,
                        faculty: fac._id,
                        programme: prog._id,
                        level,
                    };

                    const existing = await FeeTemplate.findOne(query).lean();
                    
                    const params = {
                        tuitionPerSemester: adjustedTuition,
                        academicUserFee: baseParams.academicUserFee,
                        srcFee: baseParams.srcFee,
                        practicalFee: baseParams.practicalFee,
                        cipsFee: baseParams.cipsFee,
                        latePenalty: baseParams.latePenalty,
                        scholarshipDiscount: baseParams.scholarshipDiscount,
                        installmentAllowed: true,
                        maxInstallments: 3,
                        isActive: true,
                    };

                    if (existing) {
                        await FeeTemplate.findByIdAndUpdate(existing._id, { $set: params });
                        templatesSkipped++;
                        continue;
                    }

                    try {
                        await FeeTemplate.create({
                            ...query,
                            ...params,
                        });
                        templatesCreated++;
                    } catch (err: any) {
                        console.error(`   ❌ Error creating template: ${fac.code} / ${prog.programmeName} / L${level} / ${studentType}`, err.message);
                        templatesError++;
                    }
                }
            }
        }

        console.log(`\n🎉 Repair Complete!`);
        console.log(`   Templates created : ${templatesCreated}`);
        console.log(`   Templates updated : ${templatesSkipped}`);
        console.log(`   Templates errors  : ${templatesError}\n`);

    } catch (error) {
        console.error('\n❌ Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected.\n');
    }
}

repairProgrammesAndTemplates();
