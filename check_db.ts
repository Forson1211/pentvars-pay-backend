import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { FeeType } from './src/models/FeeType';
import { FeeItem } from './src/models/FeeItem';
import { User } from './src/models/User';

dotenv.config();

const check = async () => {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pentvars-pay');

    const students = await User.find({ role: 'student' });
    console.log('--- STUDENTS ---');
    students.forEach(s => {
        console.log(`ID: ${s._id}, Email: ${s.email}`);
    });

    const types = await FeeType.find();
    console.log('--- FEE TYPES ---');
    types.forEach(t => {
        console.log(`ID: ${t._id}, Name: ${t.name}, Active: ${t.isActive}`);
    });

    const items = await FeeItem.find().populate('feeTypeId');
    console.log('--- FEE ITEMS ---');
    items.forEach(i => {
        const ft = i.feeTypeId as any;
        console.log(`ID: ${i._id}, Student: ${i.studentId}, Type: ${ft ? ft.name : 'N/A'}, Status: ${i.status}`);
    });

    await mongoose.disconnect();
};

check();
