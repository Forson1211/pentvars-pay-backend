import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { FeeType } from '../models/FeeType';
import { FeeItem } from '../models/FeeItem';
import { Transaction } from '../models/Transaction';
import { config } from '../config/env';

/**
 * Seed script to populate the database with initial data.
 * Matches the mock data that was in the frontend services.
 * 
 * Run with: npm run seed
 */
const seedDatabase = async () => {
    try {
        console.log('🌱 Connecting to MongoDB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected to MongoDB');

        // Clear existing data
        console.log('🗑️  Clearing existing data...');
        await User.deleteMany({});
        await FeeType.deleteMany({});
        await FeeItem.deleteMany({});
        await Transaction.deleteMany({});

        // ─── Create Admin User ──────────────────────────
        console.log('👤 Creating admin user...');
        const admin = await User.create({
            email: 'admin@pentvarsuniversity.edu.gh',
            password: 'admin123',
            firstName: 'Admin',
            lastName: 'User',
            role: 'admin',
            phone: '0240000000',
            department: 'Finance',
        });
        console.log(`   ✅ Admin: ${admin.email} / admin123`);

        // ─── Create Student User ────────────────────────
        console.log('👤 Creating student user...');
        const student = await User.create({
            email: 'student@pentvarsuniversity.edu.gh',
            password: 'student123',
            firstName: 'Student',
            lastName: 'User',
            role: 'student',
            studentId: '20230001',
            phone: '0241111111',
            programme: 'BSc. Information Technology',
            level: '300',
            campus: 'Main Campus',
        });
        console.log(`   ✅ Student: ${student.email} / student123`);

        // ─── Create Additional Students ─────────────────
        console.log('👥 Creating additional students...');
        const student2 = await User.create({
            email: 'john.mensah@pentvarsuniversity.edu.gh',
            password: 'password123',
            firstName: 'John',
            lastName: 'Mensah',
            role: 'student',
            studentId: '20230002',
            phone: '0242222222',
            programme: 'BSc. Computer Science',
            level: '200',
        });

        const student3 = await User.create({
            email: 'ama.serwaa@pentvarsuniversity.edu.gh',
            password: 'password123',
            firstName: 'Ama',
            lastName: 'Serwaa',
            role: 'student',
            studentId: '20230003',
            phone: '0243333333',
            programme: 'BSc. Business Administration',
            level: '400',
        });

        const student4 = await User.create({
            email: 'kwame.asante@pentvarsuniversity.edu.gh',
            password: 'password123',
            firstName: 'Kwame',
            lastName: 'Asante',
            role: 'student',
            studentId: '20230004',
            phone: '0244444444',
            programme: 'BSc. Nursing',
            level: '100',
        });

        console.log(`   ✅ Created 3 additional students`);

        // ─── Create Fee Types ───────────────────────────
        console.log('💰 Creating fee types...');
        const tuitionFee = await FeeType.create({
            name: 'Tuition Fee',
            category: 'tuition',
            amount: 8000.00,
            description: 'Tuition fee for the semester',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        const srcDues = await FeeType.create({
            name: 'SRC Dues',
            category: 'src_dues',
            amount: 1000.00,
            description: 'SRC Dues for the semester',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        const hostelFee = await FeeType.create({
            name: 'Hostel Fee',
            category: 'hostel',
            amount: 1000.00,
            description: 'Hostel Fee for the semester',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        const accommodationMaintenance = await FeeType.create({
            name: 'Accommodation Maintenance',
            category: 'hostel',
            amount: 2500.00,
            description: 'Maintenance fee for accommodation',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        const resitFee = await FeeType.create({
            name: 'Resit Exam Fee',
            category: 'resit',
            amount: 200.00,
            description: 'Fee for resit examination',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        const supplementaryFee = await FeeType.create({
            name: 'Supplementary Exam Fee',
            category: 'supplementary',
            amount: 300.00,
            description: 'Fee for supplementary examination',
            academicYear: '2025/2026',
            semester: '1',
            dueDate: new Date('2026-06-30'),
            isActive: true,
        });

        console.log('   ✅ Created 6 fee types');

        // ─── Assign Fees to Main Student ────────────────
        console.log('📋 Assigning fees to students...');

        const feeItem1 = await FeeItem.create({
            feeTypeId: tuitionFee._id,
            studentId: student._id,
            totalAmount: 8000.00,
            amountPaid: 5000.00,
            balance: 3000.00,
            status: 'partial',
            dueDate: new Date('2026-03-30'),
            academicYear: '2025/2026',
            semester: '1',
        });

        const feeItem2 = await FeeItem.create({
            feeTypeId: srcDues._id,
            studentId: student._id,
            totalAmount: 1000.00,
            amountPaid: 750.00,
            balance: 250.00,
            status: 'partial',
            dueDate: new Date('2026-02-15'),
            academicYear: '2025/2026',
            semester: '1',
        });

        await FeeItem.create({
            feeTypeId: hostelFee._id,
            studentId: student._id,
            totalAmount: 1000.00,
            amountPaid: 500.00,
            balance: 500.00,
            status: 'partial',
            dueDate: new Date('2026-04-10'),
            academicYear: '2025/2026',
            semester: '1',
        });

        await FeeItem.create({
            feeTypeId: accommodationMaintenance._id,
            studentId: student._id,
            totalAmount: 2500.00,
            amountPaid: 2500.00,
            balance: 0.00,
            status: 'paid',
            dueDate: new Date('2026-01-10'),
            academicYear: '2025/2026',
            semester: '1',
        });

        await FeeItem.create({
            feeTypeId: resitFee._id,
            studentId: student._id,
            totalAmount: 200.00,
            amountPaid: 0.00,
            balance: 200.00,
            status: 'pending',
            dueDate: new Date('2026-05-15'),
            academicYear: '2025/2026',
            semester: '1',
        });

        await FeeItem.create({
            feeTypeId: supplementaryFee._id,
            studentId: student._id,
            totalAmount: 300.00,
            amountPaid: 0.00,
            balance: 300.00,
            status: 'pending',
            dueDate: new Date('2026-05-20'),
            academicYear: '2025/2026',
            semester: '1',
        });

        // Assign tuition to other students too
        for (const s of [student2, student3, student4]) {
            await FeeItem.create({
                feeTypeId: tuitionFee._id,
                studentId: s._id,
                totalAmount: 8000.00,
                amountPaid: 0,
                balance: 8000.00,
                status: 'pending',
                dueDate: new Date('2026-06-30'),
                academicYear: '2025/2026',
                semester: '1',
            });
        }

        console.log('   ✅ Assigned fees to 4 students');

        // ─── Create Sample Transactions ─────────────────
        console.log('📝 Creating sample transactions...');

        await Transaction.create({
            studentId: student._id,
            feeItemId: feeItem1._id,
            amount: 2500.00,
            paymentMethod: 'mobile_money',
            status: 'completed',
            reference: 'PAY-REF123456',
            description: 'Tuition Fee Payment',
            paidAt: new Date('2026-02-10T10:30:00Z'),
        });

        await Transaction.create({
            studentId: student._id,
            feeItemId: feeItem1._id,
            amount: 2500.00,
            paymentMethod: 'mobile_money',
            status: 'completed',
            reference: 'PAY-REF123457',
            description: 'Tuition Fee Payment',
            paidAt: new Date('2026-02-08T14:20:00Z'),
        });

        await Transaction.create({
            studentId: student2._id,
            feeItemId: feeItem1._id,
            amount: 3000.00,
            paymentMethod: 'bank_transfer',
            status: 'completed',
            reference: 'PAY-REF223456',
            description: 'Tuition Fee Payment',
            paidAt: new Date('2026-02-12T08:00:00Z'),
        });

        await Transaction.create({
            studentId: student3._id,
            feeItemId: feeItem2._id,
            amount: 2500.00,
            paymentMethod: 'card',
            status: 'completed',
            reference: 'PAY-REF323456',
            description: 'SRC Dues Payment',
            paidAt: new Date('2026-02-12T04:00:00Z'),
        });

        await Transaction.create({
            studentId: student4._id,
            feeItemId: feeItem1._id,
            amount: 1000.00,
            paymentMethod: 'mobile_money',
            status: 'pending',
            reference: 'PAY-REF423456',
            description: 'Tuition Fee Payment',
        });

        console.log('   ✅ Created 5 sample transactions');

        // ─── Summary ────────────────────────────────────
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║           🎓 Database Seeded Successfully!          ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log('║                                                      ║');
        console.log('║  📧 Admin Login:                                     ║');
        console.log('║     Email:    admin@pentvarsuniversity.edu.gh        ║');
        console.log('║     Password: admin123                               ║');
        console.log('║                                                      ║');
        console.log('║  📧 Student Login:                                   ║');
        console.log('║     Email:    student@pentvarsuniversity.edu.gh      ║');
        console.log('║     Password: student123                             ║');
        console.log('║                                                      ║');
        console.log('║  📊 Data Created:                                    ║');
        console.log('║     • 1 Admin + 4 Students                          ║');
        console.log('║     • 6 Fee Types                                    ║');
        console.log('║     • 9 Fee Assignments                              ║');
        console.log('║     • 5 Transactions                                 ║');
        console.log('║                                                      ║');
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');

        process.exit(0);
    } catch (error) {
        console.error('❌ Seed Error:', error);
        process.exit(1);
    }
};

seedDatabase();
