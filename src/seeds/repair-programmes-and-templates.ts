/**
 * repair-programmes-and-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Ensures ALL 23 programmes exist (matching seedFaculties.ts data)
 * 2. For each programme × level × student type, creates a fee template
 *    if one doesn't already exist (using the same fee parameters from seedFaculties.ts)
 *
 * Expected result: 23 programmes × 4 levels × 3 student types = 276 templates
 * Run with:  npx ts-node src/seeds/repair-programmes-and-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { config } from '../config/env';

// ── Data matching seedFaculties.ts ──────────────────────────────────────────

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

// Fee parameters by faculty code (same as seedFaculties.ts)
function getTemplateParams(facultyCode: string, level: string) {
    let tuition = 0;
    let practicalFee = 0;
    let cipsFee = 0;
    const isL100 = level === '100';

    switch (facultyCode) {
        case 'FESAC':
            tuition = 2553;
            break;
        case 'PSTM':
            tuition = 2553;
            break;
        case 'BA':
            tuition = 2783;
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
            cipsFee = 800;
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
            break;
        default:
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

const STUDENT_TYPES: Array<'regular' | 'weekend' | 'international'> = ['regular', 'weekend', 'international'];
const LEVELS = ['100', '200', '300', '400'];
const MULTIPLIERS: Record<string, number> = { regular: 1.0, weekend: 1.1, international: 1.5 };

async function repairProgrammesAndTemplates() {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('\n🔌 Connected to MongoDB\n');

        // ── 1. Get active academic year ──
        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
        if (!activeYear) throw new Error('No active academic year found!');
        console.log(`📅 Active Year: ${activeYear.yearLabel} (${activeYear._id})\n`);

        // ── 2. Ensure all programmes exist ──
        console.log('🎓 Checking / Creating Programmes...');
        let programmesCreated = 0;
        let programmesSkipped = 0;

        for (const [facultyCode, programmeNames] of Object.entries(PROGRAMMES_MAP)) {
            const faculty = await Faculty.findOne({ code: facultyCode }).lean();
            if (!faculty) {
                console.log(`   ⚠️  Faculty "${facultyCode}" not found in DB — skipping`);
                continue;
            }

            for (const progName of programmeNames) {
                const existing = await Programme.findOne({
                    faculty: faculty._id,
                    programmeName: progName,
                }).lean();

                if (existing) {
                    programmesSkipped++;
                    continue;
                }

                await Programme.create({
                    faculty: faculty._id,
                    programmeName: progName,
                });
                programmesCreated++;
                console.log(`   ✅ Created: [${facultyCode}] ${progName}`);
            }
        }

        const totalProgrammes = await Programme.countDocuments({});
        console.log(`\n   Programmes created: ${programmesCreated}, skipped: ${programmesSkipped}`);
        console.log(`   Total programmes in DB: ${totalProgrammes}\n`);

        // ── 3. Create missing fee templates ──
        console.log('💰 Creating missing fee templates...\n');

        const before: Record<string, number> = {};
        for (const t of STUDENT_TYPES) {
            before[t] = await FeeTemplate.countDocuments({ studentType: t, academicYear: activeYear._id });
        }
        console.log('📈 Before:');
        for (const t of STUDENT_TYPES) console.log(`   ${t.padEnd(15)}: ${before[t]}`);
        console.log('');

        let templatesCreated = 0;
        let templatesSkipped = 0;
        let templatesError = 0;

        // Fetch all programmes with their faculties
        const allProgrammes = await Programme.find({}).populate('faculty').lean();

        for (const prog of allProgrammes) {
            const fac = prog.faculty as any;
            if (!fac || !fac.code) continue;

            const baseParams = getTemplateParams(fac.code, '100'); // will be overridden per level below

            for (const level of LEVELS) {
                const levelParams = getTemplateParams(fac.code, level);

                for (const studentType of STUDENT_TYPES) {
                    const multiplier = MULTIPLIERS[studentType];
                    const adjustedTuition = Math.round(levelParams.tuitionPerSemester * multiplier);

                    const query = {
                        academicYear: activeYear._id,
                        studentType,
                        faculty: fac._id,
                        programme: prog._id,
                        level,
                    };

                    const existing = await FeeTemplate.findOne(query).lean();
                    if (existing) {
                        templatesSkipped++;
                        continue;
                    }

                    try {
                        await FeeTemplate.create({
                            ...query,
                            tuitionPerSemester: adjustedTuition,
                            academicUserFee: levelParams.academicUserFee,
                            srcFee: levelParams.srcFee,
                            practicalFee: levelParams.practicalFee,
                            cipsFee: levelParams.cipsFee,
                            latePenalty: levelParams.latePenalty,
                            scholarshipDiscount: levelParams.scholarshipDiscount,
                            installmentAllowed: true,
                            maxInstallments: 3,
                            isActive: true,
                        });
                        templatesCreated++;
                    } catch (err: any) {
                        if (err.code === 11000) {
                            // Duplicate key — already exists (race condition or index), skip
                            templatesSkipped++;
                        } else {
                            console.error(`   ❌ Error creating template: ${fac.code} / ${prog.programmeName} / L${level} / ${studentType}`, err.message);
                            templatesError++;
                        }
                    }
                }
            }
        }

        // ── 4. Final summary ──
        const after: Record<string, number> = {};
        for (const t of STUDENT_TYPES) {
            after[t] = await FeeTemplate.countDocuments({ studentType: t, academicYear: activeYear._id });
        }
        const totalAfter = await FeeTemplate.countDocuments({ academicYear: activeYear._id });
        const totalProgs = await Programme.countDocuments({});

        console.log('\n📈 After:');
        for (const t of STUDENT_TYPES) {
            const ok = after[t] === after['regular'] ? '✅' : '⚠️ ';
            console.log(`   ${ok} ${t.padEnd(15)}: ${after[t]}`);
        }

        console.log(`\n╔═══════════════════════════════════════════════════════╗`);
        console.log(`║  🎉 Repair Complete!                                  ║`);
        console.log(`╠═══════════════════════════════════════════════════════╣`);
        console.log(`║  Programmes in DB  : ${String(totalProgs).padEnd(33)}║`);
        console.log(`║  Templates created : ${String(templatesCreated).padEnd(33)}║`);
        console.log(`║  Templates skipped : ${String(templatesSkipped).padEnd(33)}║`);
        console.log(`║  Templates errors  : ${String(templatesError).padEnd(33)}║`);
        console.log(`║  Total templates   : ${String(totalAfter).padEnd(33)}║`);
        console.log(`║  Expected (if 23p) : ${String(23 * 4 * 3).padEnd(33)}║`);
        console.log(`╚═══════════════════════════════════════════════════════╝\n`);

    } catch (error) {
        console.error('\n❌ Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected.\n');
    }
}

repairProgrammesAndTemplates();
