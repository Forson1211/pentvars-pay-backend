import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { AcademicYear } from '../models/AcademicYear';
import { Programme } from '../models/Programme';
import { FeeTemplate } from '../models/FeeTemplate';
import { StudentFee } from '../models/StudentFee';
import { Payment } from '../models/Payment';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pentvars-pay';

/**
 * Seed the database with comprehensive test data for the Dynamic Fee Management System
 */
async function seedDynamicFeeSystem() {
    try {
        console.log('\n🌱 Starting Dynamic Fee Management System Seed...\n');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');

        // ──── Clear New Collections (keep existing users if desired) ────
        console.log('🧹 Clearing fee management collections...');
        await AcademicYear.deleteMany({});
        await Programme.deleteMany({});
        await FeeTemplate.deleteMany({});
        await StudentFee.deleteMany({});
        await Payment.deleteMany({});
        console.log('   ✅ Collections cleared\n');

        // ──── 1. Create Academic Years ────
        console.log('📅 Creating Academic Years...');
        const [year2026, year2027] = await AcademicYear.create([
            {
                yearLabel: '2026/2027',
                isActive: true,
                startDate: new Date('2026-09-01'),
                endDate: new Date('2027-08-31'),
            },
            {
                yearLabel: '2027/2028',
                isActive: false,
                startDate: new Date('2027-09-01'),
                endDate: new Date('2028-08-31'),
            },
        ]);
        console.log(`   ✅ Created: ${year2026.yearLabel} (Active), ${year2027.yearLabel}\n`);

        // ──── 2. Create Programmes ────
        console.log('🎓 Creating Programmes...');
        const programmes = await Programme.create([
            // Faculty of Business Administration
            {
                faculty: 'Faculty of Business Administration',
                programmeName: 'Business Administration',
                code: 'BA',
                duration: 4,
            },
            {
                faculty: 'Faculty of Business Administration',
                programmeName: 'Accounting',
                code: 'ACC',
                duration: 4,
            },
            {
                faculty: 'Faculty of Business Administration',
                programmeName: 'Banking and Finance',
                code: 'BF',
                duration: 4,
            },
            // Faculty of Information Technology
            {
                faculty: 'Faculty of Information Technology',
                programmeName: 'Information Technology',
                code: 'IT',
                duration: 4,
            },
            {
                faculty: 'Faculty of Information Technology',
                programmeName: 'Computer Science',
                code: 'CS',
                duration: 4,
            },
            // Faculty of Engineering
            {
                faculty: 'Faculty of Engineering',
                programmeName: 'Mechanical Engineering',
                code: 'ME',
                duration: 4,
            },
            {
                faculty: 'Faculty of Engineering',
                programmeName: 'Electrical Engineering',
                code: 'EE',
                duration: 4,
            },
            // Faculty of Applied Sciences
            {
                faculty: 'Faculty of Applied Sciences',
                programmeName: 'Nursing',
                code: 'NUR',
                duration: 4,
            },
        ]);

        console.log(`   ✅ Created ${programmes.length} programmes\n`);

        // Create a map for easy reference
        const progMap: Record<string, any> = {};
        programmes.forEach(p => {
            progMap[p.code!] = p;
        });

        // ──── 3. Create Admin User (if not exists) ────
        console.log('👤 Creating Admin User...');
        let admin = await User.findOne({ email: 'admin@pentvars.edu.gh' });
        if (!admin) {
            admin = await User.create({
                email: 'admin@pentvars.edu.gh',
                password: 'Admin@123',
                firstName: 'Super',
                lastName: 'Admin',
                role: 'admin',
                position: 'Super Admin',
                status: 'active',
            });
            console.log('   ✅ Admin created: admin@pentvars.edu.gh / Admin@123');
        } else {
            console.log('   ℹ️  Admin already exists');
        }
        console.log('');

        // ──── 4. Create Test Students ────
        console.log('🧑‍🎓 Creating Test Students...');

        // Delete existing test students
        await User.deleteMany({
            email: {
                $in: [
                    'john.doe@stu.pentvars.edu.gh',
                    'jane.smith@stu.pentvars.edu.gh',
                    'kwame.mensah@stu.pentvars.edu.gh',
                    'amara.williams@stu.pentvars.edu.gh',
                    'kofi.asante@stu.pentvars.edu.gh',
                    'fatima.ibrahim@stu.pentvars.edu.gh',
                ]
            }
        });

        const students = await User.create([
            {
                email: 'john.doe@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'John',
                lastName: 'Doe',
                role: 'student',
                studentId: 'PV/2024/001',
                phone: '0201234567',
                programme: 'Business Administration',
                programmeRef: progMap['BA']._id,
                level: '200',
                stream: 'regular',
                nationality: 'ghanaian',
                hostelOption: false,
                status: 'active',
            },
            {
                email: 'jane.smith@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'Jane',
                lastName: 'Smith',
                role: 'student',
                studentId: 'PV/2024/002',
                phone: '0209876543',
                programme: 'Information Technology',
                programmeRef: progMap['IT']._id,
                level: '100',
                stream: 'regular',
                nationality: 'ghanaian',
                hostelOption: true,
                status: 'active',
            },
            {
                email: 'kwame.mensah@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'Kwame',
                lastName: 'Mensah',
                role: 'student',
                studentId: 'PV/2024/003',
                phone: '0551234567',
                programme: 'Accounting',
                programmeRef: progMap['ACC']._id,
                level: '300',
                stream: 'weekend',
                nationality: 'ghanaian',
                hostelOption: false,
                status: 'active',
            },
            {
                email: 'amara.williams@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'Amara',
                lastName: 'Williams',
                role: 'student',
                studentId: 'PV/2024/004',
                phone: '0241234567',
                programme: 'Computer Science',
                programmeRef: progMap['CS']._id,
                level: '200',
                stream: 'regular',
                nationality: 'international',
                hostelOption: true,
                status: 'active',
            },
            {
                email: 'kofi.asante@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'Kofi',
                lastName: 'Asante',
                role: 'student',
                studentId: 'PV/2024/005',
                phone: '0271234567',
                programme: 'Nursing',
                programmeRef: progMap['NUR']._id,
                level: '100',
                stream: 'regular',
                nationality: 'ghanaian',
                hostelOption: false,
                status: 'active',
            },
            {
                email: 'fatima.ibrahim@stu.pentvars.edu.gh',
                password: 'Student@123',
                firstName: 'Fatima',
                lastName: 'Ibrahim',
                role: 'student',
                studentId: 'PV/2024/006',
                phone: '0501234567',
                programme: 'Banking and Finance',
                programmeRef: progMap['BF']._id,
                level: '400',
                stream: 'weekend',
                nationality: 'ghanaian',
                hostelOption: false,
                status: 'active',
            },
        ]);

        console.log(`   ✅ Created ${students.length} test students (password: Student@123)\n`);

        // ──── 5. Create Fee Templates ────
        console.log('💰 Creating Fee Templates...');

        const templateData: any[] = [];

        // For each programme, create templates for different student types and levels
        const feeConfigs: Record<string, { tuition: number; practical: number; cips: number }> = {
            // Business programmes
            'BA': { tuition: 3500, practical: 0, cips: 200 },
            'ACC': { tuition: 3500, practical: 0, cips: 200 },
            'BF': { tuition: 3500, practical: 0, cips: 200 },
            // IT programmes
            'IT': { tuition: 4000, practical: 500, cips: 250 },
            'CS': { tuition: 4000, practical: 500, cips: 250 },
            // Engineering programmes
            'ME': { tuition: 5000, practical: 800, cips: 300 },
            'EE': { tuition: 5000, practical: 800, cips: 300 },
            // Health programmes
            'NUR': { tuition: 4500, practical: 600, cips: 250 },
        };

        const studentTypes = ['regular', 'weekend', 'international'];
        const levels = ['100', '200', '300', '400'];

        for (const [code, config] of Object.entries(feeConfigs)) {
            const prog = progMap[code];

            for (const type of studentTypes) {
                for (const level of levels) {
                    // Adjust tuition by student type
                    let tuitionMultiplier = 1;
                    if (type === 'weekend') tuitionMultiplier = 1.25;
                    if (type === 'international') tuitionMultiplier = 2.5;

                    const tuition = Math.round(config.tuition * tuitionMultiplier);

                    templateData.push({
                        academicYear: year2026._id,
                        studentType: type,
                        programme: prog._id,
                        level,
                        tuitionPerSemester: tuition,
                        academicUserFee: 800, // Annual
                        srcFee: 200, // Annual
                        practicalFee: config.practical,
                        cipsFee: config.cips,
                        latePenalty: 200,
                        scholarshipDiscount: 0,
                        installmentAllowed: true,
                        maxInstallments: 3,
                        createdBy: admin!._id,
                    });
                }
            }
        }

        const templates = await FeeTemplate.create(templateData);
        console.log(`   ✅ Created ${templates.length} fee templates for ${Object.keys(feeConfigs).length} programmes × 3 student types × 4 levels\n`);

        // ──── Summary ────
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║     🎉 Dynamic Fee Management System Seeded!        ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  📅 Academic Years:     ${await AcademicYear.countDocuments()}                          ║`);
        console.log(`║  🎓 Programmes:         ${await Programme.countDocuments()}                          ║`);
        console.log(`║  💰 Fee Templates:      ${(await FeeTemplate.countDocuments()).toString().padEnd(3)}                       ║`);
        console.log(`║  👤 Admin Users:        ${await User.countDocuments({ role: 'admin' })}                          ║`);
        console.log(`║  🧑‍🎓 Student Users:      ${await User.countDocuments({ role: 'student' })}                          ║`);
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log('║  🔑 Admin Login:                                    ║');
        console.log('║     Email:    admin@pentvars.edu.gh                  ║');
        console.log('║     Password: Admin@123                             ║');
        console.log('║                                                     ║');
        console.log('║  🔑 Student Login (any):                            ║');
        console.log('║     Email:    john.doe@stu.pentvars.edu.gh           ║');
        console.log('║     Password: Student@123                           ║');
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');

    } catch (error) {
        console.error('❌ Seed Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Database disconnected.\n');
    }
}

seedDynamicFeeSystem();
