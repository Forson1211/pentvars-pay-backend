import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { AcademicYear } from '../models/AcademicYear';
import { FeeTemplate } from '../models/FeeTemplate';

/**
 * Seed script: Populates faculties and sample programmes.
 * Run with: npx ts-node src/seeds/seedFaculties.ts
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

// Sample programmes per faculty (can be expanded by admin later)
const PROGRAMMES_MAP: Record<string, string[]> = {
    'FESAC': [
        'BSc. Information Technology',
        'BSc. Computer Science',
        'BSc. Computer Engineering',
        'BSc. Mathematics',
    ],
    'BENV': [
        'BSc. Architecture',
        'BSc. Quantity Surveying',
        'BSc. Construction Technology',
    ],
    'LAW': [
        'LLB Law',
    ],
    'PSTM': [
        'BA. Theology',
        'BA. Mission Studies',
    ],
    'BA': [
        'BSc. Accounting',
        'BSc. Banking & Finance',
        'BSc. Marketing',
        'BSc. Human Resource Management',
        'BSc. Management',
    ],
    'FEHAS': [
        'BSc. Public Health',
        'BSc. Health Administration',
    ],
    'DHM': [
        'Doctor of Herbal Medicine',
    ],
    'FEHAS-ENG': [
        'BSc. Biomedical Engineering',
    ],
    'NUR': [
        'BSc. Nursing',
    ],
    'PA': [
        'BSc. Physician Assistantship',
    ],
    'MID': [
        'BSc. Midwifery',
    ],
    'BA-LOG': [
        'BSc. Logistics & Supply Chain Management',
    ],
};

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

        // Seed faculties
        let facultiesCreated = 0;
        let facultiesSkipped = 0;

        for (const facData of FACULTIES) {
            const existing = await Faculty.findOne({ name: facData.name });
            if (existing) {
                facultiesSkipped++;
                continue;
            }
            await Faculty.create(facData);
            facultiesCreated++;
        }
        console.log(`✅ Faculties: ${facultiesCreated} created, ${facultiesSkipped} already existed.`);

        // Seed programmes
        let programmesCreated = 0;
        let programmesSkipped = 0;

        for (const [facultyCode, programmeNames] of Object.entries(PROGRAMMES_MAP)) {
            const faculty = await Faculty.findOne({ code: facultyCode });
            if (!faculty) {
                console.log(`⚠️  Faculty with code ${facultyCode} not found, skipping its programmes.`);
                continue;
            }

            for (const progName of programmeNames) {
                const existing = await Programme.findOne({
                    faculty: faculty._id,
                    programmeName: progName,
                });
                if (existing) {
                    programmesSkipped++;
                    continue;
                }
                await Programme.create({
                    faculty: faculty._id,
                    programmeName: progName,
                });
                programmesCreated++;
            }
        }
        console.log(`✅ Programmes: ${programmesCreated} created, ${programmesSkipped} already existed.`);

        console.log('\n🧹 Clearing Old/Unknown Fee Templates...');
        await FeeTemplate.deleteMany({}); // Delete all existing templates to clear unknowns
        console.log('✅ All old fee templates removed.');

        console.log('\n💸 Generating Fee Templates (2026/2027 All Student Types)...');

        const getTemplateParams = (facultyCode: string, level: string) => {
            let tuition = 0;
            let practicalFee = 0;
            let cipsFee = 0;

            const isL100 = level === '100';

            switch (facultyCode) {
                case 'FESAC':
                    tuition = 2553;
                    practicalFee = 0;
                    break;
                case 'PSTM':
                    tuition = 2553;
                    break;
                case 'BA':
                    tuition = 2783;
                    // Prompt mentioned practical 800 if applicable, but explicitly said "clinical/engineering only"
                    practicalFee = 0;
                    break;
                case 'NUR':
                case 'PA':
                case 'MID':
                    tuition = isL100 ? 3420 : 4400;
                    practicalFee = 900;
                    break;
                case 'DHM':
                    tuition = isL100 ? 3974 : 5500;
                    practicalFee = 1000;
                    break;
                case 'BA-LOG':
                    tuition = 2750;
                    cipsFee = 800; // Annual CIPS fee
                    break;
                case 'BENV':
                    tuition = 2783;
                    practicalFee = 800;
                    break;
                case 'LAW':
                    tuition = 2750;
                    practicalFee = 900;
                    break;
                case 'FEHAS':
                    tuition = 3420;
                    practicalFee = 900;
                    break;
                case 'FEHAS-ENG':
                    tuition = 1815;
                    practicalFee = 0;
                    break;
                default:
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
        };

        const studentTypes = ['regular', 'weekend', 'international'];
        const levels = ['100', '200', '300', '400'];
        let templatesCreated = 0;
        let templatesSkipped = 0;

        // Fetch all programmes with matching faculties
        const allProgrammes = await Programme.find().populate('faculty');

        for (const prog of allProgrammes) {
            const fac = prog.faculty as any;
            if (!fac || !fac.code) continue;

            for (const level of levels) {
                const params = getTemplateParams(fac.code, level);

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

        console.log(`✅ Fee Templates: ${templatesCreated} created, ${templatesSkipped} already existed.`);

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
