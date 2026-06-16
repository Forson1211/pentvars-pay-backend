import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { config } from './src/config/env';
import { User } from './src/models/User';

const run = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('Connected to DB');

        const testEmail = 'testadmin' + Date.now() + '@pentvarsuniversity.edu.gh';
        
        const existing = await User.findOne({ email: testEmail });
        if (existing) {
            console.log('User already exists');
            return;
        }

        const staff = await User.create({
            email: testEmail,
            password: 'password123',
            firstName: 'Test',
            lastName: 'Admin',
            phone: '0241112222',
            role: 'admin',
            position: 'Finance Officer',
            permissions: ['all'],
            status: 'active'
        });

        console.log('Created staff:', staff.toJSON());

        // Now find it back
        const found = await User.findOne({ email: testEmail });
        console.log('Found staff in DB:', found ? found.toJSON() : 'Not found');

        // Delete test staff
        await User.deleteOne({ email: testEmail });
        console.log('Cleaned up test staff');

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error during create-staff test:', err);
    }
};

run();
