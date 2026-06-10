/**
 * repair-fee-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Repairs the fee template database by ensuring ALL three student types
 * (regular, weekend, international) have templates for every
 * faculty × programme × level combination.
 *
 * Run with:  npx ts-node src/seeds/repair-fee-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { FeeTemplate } from '../models/FeeTemplate';
import { AcademicYear } from '../models/AcademicYear';
import { config } from '../config/env';

const STUDENT_TYPES: Array<'regular' | 'weekend' | 'international'> = ['regular', 'weekend', 'international'];

// Fee multipliers vs regular
const MULTIPLIERS: Record<string, number> = {
    regular: 1.0,
    weekend: 1.1,       // 10% premium
    international: 1.5, // 50% premium
};

async function repairFeeTemplates() {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('\n🔌 Connected to MongoDB');
        console.log('📍 DB:', config.mongoURI.replace(/\/\/.*@/, '//<credentials>@'));

        // ── Get the active academic year ──
        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
        if (!activeYear) {
            throw new Error('No active academic year found! Please activate one first.');
        }
        console.log(`\n📅 Active Academic Year: ${activeYear.yearLabel} (${activeYear._id})\n`);

        // ── Load all existing REGULAR templates as the base ──
        const regularTemplates = await FeeTemplate.find({
            academicYear: activeYear._id,
            studentType: 'regular',
        }).lean();

        console.log(`📊 Found ${regularTemplates.length} regular templates as base\n`);

        if (regularTemplates.length === 0) {
            console.error('❌ No regular templates found for the active year! Cannot proceed.');
            process.exit(1);
        }

        // ── Count before ──
        const before: Record<string, number> = {};
        for (const t of STUDENT_TYPES) {
            before[t] = await FeeTemplate.countDocuments({ studentType: t, academicYear: activeYear._id });
        }
        console.log('📈 Current counts (before repair):');
        for (const t of STUDENT_TYPES) {
            console.log(`   ${t.padEnd(15)}: ${before[t]}`);
        }
        console.log('');

        // ── For each combination, ensure weekend and international exist ──
        let created = 0;
        let skipped = 0;

        for (const baseTemplate of regularTemplates) {
            for (const targetType of ['weekend', 'international'] as const) {
                const multiplier = MULTIPLIERS[targetType];

                // Check if already exists
                const existing = await FeeTemplate.findOne({
                    academicYear: activeYear._id,
                    faculty: baseTemplate.faculty,
                    programme: baseTemplate.programme,
                    level: baseTemplate.level,
                    studentType: targetType,
                });

                if (existing) {
                    skipped++;
                    continue;
                }

                // Create from regular base with adjusted tuition
                const adjustedTuition = Math.round(baseTemplate.tuitionPerSemester * multiplier);

                await FeeTemplate.create({
                    academicYear: activeYear._id,
                    studentType: targetType,
                    faculty: baseTemplate.faculty,
                    programme: baseTemplate.programme,
                    level: baseTemplate.level,

                    // Tuition scales by student type; other fees remain the same
                    tuitionPerSemester: adjustedTuition,
                    academicUserFee: baseTemplate.academicUserFee,
                    srcFee: baseTemplate.srcFee,
                    practicalFee: baseTemplate.practicalFee,
                    cipsFee: baseTemplate.cipsFee,
                    latePenalty: baseTemplate.latePenalty,
                    scholarshipDiscount: baseTemplate.scholarshipDiscount,
                    installmentAllowed: baseTemplate.installmentAllowed,
                    maxInstallments: baseTemplate.maxInstallments,
                    dueDate: baseTemplate.dueDate,
                    isActive: true,
                    // createdBy not set (repair script)
                });

                created++;
                process.stdout.write(`   ✅ Created ${targetType} | level ${baseTemplate.level}\r`);
            }
        }

        // ── Count after ──
        const after: Record<string, number> = {};
        for (const t of STUDENT_TYPES) {
            after[t] = await FeeTemplate.countDocuments({ studentType: t, academicYear: activeYear._id });
        }

        console.log('\n\n📈 Final counts (after repair):');
        for (const t of STUDENT_TYPES) {
            const expected = after['regular'];
            const actual = after[t];
            const ok = actual === expected ? '✅' : '⚠️ ';
            console.log(`   ${ok} ${t.padEnd(15)}: ${actual} (expected ${expected})`);
        }

        const totalAfter = await FeeTemplate.countDocuments({ academicYear: activeYear._id });

        console.log(`\n╔═══════════════════════════════════════════════╗`);
        console.log(`║  🎉 Fee Template Repair Complete!             ║`);
        console.log(`╠═══════════════════════════════════════════════╣`);
        console.log(`║  Templates created : ${String(created).padEnd(24)}║`);
        console.log(`║  Templates skipped : ${String(skipped).padEnd(24)}║`);
        console.log(`║  Total in DB now   : ${String(totalAfter).padEnd(24)}║`);
        console.log(`╚═══════════════════════════════════════════════╝\n`);

    } catch (error) {
        console.error('\n❌ Repair failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected.\n');
    }
}

repairFeeTemplates();
