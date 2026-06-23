import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { AcademicYear } from '../models/AcademicYear';
import { FeeTemplate } from '../models/FeeTemplate';

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
        latePenalty: 100, // standard default
        scholarshipDiscount: 0,
    };
}

async function seedFaculties() {
    try {
        await connectDB();

        console.log('\n🎓 Seeding Faculties & Programmes...\n');

        // Wait: Ensure 2026/2027 exists and is active.
        let activeYear = await AcademicYear.findOne({ yearLabel: '2026/2027' });
        if (!activeYear) {
            // Deactivate others
            await AcademicYear.updateMany({}, { isActive: false });
            activeYear = await AcademicYear.create({
                yearLabel: '2026/2027',
                startDate: new Date('2026-09-01'),
                endDate: new Date('2027-07-31'),
                isActive: true, // Make this the active one
            });
            console.log(`📅 Created academic year: ${activeYear.yearLabel}`);
        } else {
            console.log(`📅 Academic year exists: ${activeYear.yearLabel}`);
        }

        // Ensure this year is active
        if (!activeYear.isActive) {
            await AcademicYear.updateMany({}, { isActive: false });
            activeYear.isActive = true;
            await activeYear.save();
        }

        // Seed faculties (clean up non-active ones)
        let facultiesCreated = 0;
        let facultiesSkipped = 0;

        for (const facData of FACULTIES) {
            const existing = await Faculty.findOne({ code: facData.code });
            if (existing) {
                existing.name = facData.name;
                existing.isActive = true;
                await existing.save();
                facultiesSkipped++;
                continue;
            }
            await Faculty.create(facData);
            facultiesCreated++;
        }
        console.log(`✅ Faculties: ${facultiesCreated} created, ${facultiesSkipped} updated/skipped.`);

        // Delete faculties not in target list
        const activeCodes = FACULTIES.map(f => f.code);
        await Faculty.deleteMany({ code: { $nin: activeCodes } });

        // Seed programmes
        let programmesCreated = 0;
        let programmesSkipped = 0;
        const progMap: Record<string, any> = {};

        for (const [facultyCode, progs] of Object.entries(PROGRAMMES_MAP)) {
            const faculty = await Faculty.findOne({ code: facultyCode });
            if (!faculty) {
                console.log(`⚠️  Faculty with code ${facultyCode} not found, skipping its programmes.`);
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
                    await existing.save();
                    programmesSkipped++;
                    progMap[progData.programmeName] = existing;
                    continue;
                }
                const newProg = await Programme.create({
                    faculty: faculty._id,
                    programmeName: progData.programmeName,
                    code: progData.code,
                });
                programmesCreated++;
                progMap[progData.programmeName] = newProg;
            }
        }
        console.log(`✅ Programmes: ${programmesCreated} created, ${programmesSkipped} updated/skipped.`);

        // Delete programmes not in target list
        const activeProgCodes = Object.values(PROGRAMMES_MAP).flat().map(p => p.code);
        await Programme.deleteMany({ code: { $nin: activeProgCodes } });

        console.log('\n🧹 Clearing Old/Unknown Fee Templates...');
        const activeFacIds = FACULTIES.map(f => f.code);
        const dbFacs = await Faculty.find({ code: { $in: activeFacIds } });
        const dbFacIds = dbFacs.map(f => f._id);
        const dbProgs = await Programme.find({ code: { $in: activeProgCodes } });
        const dbProgIds = dbProgs.map(p => p._id);

        await FeeTemplate.deleteMany({
            $or: [
                { faculty: { $nin: dbFacIds } },
                { programme: { $nin: dbProgIds } }
            ]
        });
        console.log('✅ Obsolete fee templates removed.');

        console.log('\n💸 Generating Fee Templates (2026/2027 All Student Types)...');

        const studentTypes = ['regular', 'weekend', 'international'];
        const levels = ['100', '200', '300', '400'];
        let templatesCreated = 0;
        let templatesSkipped = 0;

        for (const prog of dbProgs) {
            const fac = dbFacs.find(f => f._id.toString() === prog.faculty.toString());
            if (!fac || !fac.code) continue;

            for (const level of levels) {
                const params = getTemplateParams(fac.code, prog.code || '', level);

                for (const studentType of studentTypes) {
                    let finalParams = { ...params };

                    if (studentType === 'international') {
                        finalParams.tuitionPerSemester = Math.round(finalParams.tuitionPerSemester * 1.5);
                    } else if (studentType === 'weekend') {
                        finalParams.tuitionPerSemester = Math.round(finalParams.tuitionPerSemester * 1.1);
                    }

                    const query = {
                        academicYear: activeYear._id,
                        studentType,
                        faculty: fac._id,
                        programme: prog._id,
                        level,
                    };

                    const existingTpl = await FeeTemplate.findOne(query);
                    if (existingTpl) {
                        await FeeTemplate.findByIdAndUpdate(existingTpl._id, { $set: finalParams });
                        templatesSkipped++;
                        continue;
                    }

                    await FeeTemplate.create({
                        ...query,
                        ...finalParams,
                        isActive: true,
                    });
                    templatesCreated++;
                }
            }
        }

        console.log(`✅ Fee Templates: ${templatesCreated} created, ${templatesSkipped} updated.`);

        // Summary
        const totalFaculties = await Faculty.countDocuments();
        const totalProgrammes = await Programme.countDocuments();
        console.log(`\n📊 Database Summary:`);
        console.log(`   Faculties:  ${totalFaculties}`);
        console.log(`   Programmes: ${totalProgrammes}`);
        console.log(`   Fee Templates: ${await FeeTemplate.countDocuments()}`);
        console.log(`   Academic Year: ${activeYear.yearLabel} (active)\n`);

        console.log('🎉 Seeding complete!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
}

seedFaculties();
