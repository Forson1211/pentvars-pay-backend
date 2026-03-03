import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { FeeItem } from '../models/FeeItem';
import { Transaction } from '../models/Transaction';
import { config } from '../config/env';

const clearSeededData = async () => {
    try {
        console.log('🌱 Connecting to MongoDB...');
        await mongoose.connect(config.mongoURI);
        console.log('✅ Connected to MongoDB');

        const seedEmails = [
            'student@pentvarsuniversity.edu.gh',
            'john.mensah@pentvarsuniversity.edu.gh',
            'ama.serwaa@pentvarsuniversity.edu.gh',
            'kwame.asante@pentvarsuniversity.edu.gh'
        ];

        const seedIds = ['20230001', '20230002', '20230003', '20230004'];

        // Find users to delete
        const usersToDelete = await User.find({
            $or: [
                { email: { $in: seedEmails } },
                { studentId: { $in: seedIds } },
                { firstName: 'Student', lastName: 'User' }
            ]
        });

        for (const user of usersToDelete) {
            console.log(`🗑️ Deleting seeded user: ${user.firstName} ${user.lastName} (${user.email || user.studentId})`);

            // Clear their related data
            await Promise.all([
                FeeItem.deleteMany({ studentId: user._id }),
                Transaction.deleteMany({ studentId: user._id }),
                User.deleteOne({ _id: user._id })
            ]);
        }

        console.log(`✅ ${usersToDelete.length} seeded dummy accounts cleared.`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Error clearing seeds:', error);
        process.exit(1);
    }
};

clearSeededData();
