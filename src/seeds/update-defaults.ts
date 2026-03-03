import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { User } from '../models/User';
import { config } from '../config/env';

const updateDefaults = async () => {
    try {
        await mongoose.connect(config.mongoURI);
        const result = await User.updateMany(
            { role: 'student', stream: { $exists: false } },
            { $set: { stream: 'regular', nationality: 'ghanaian' } }
        );
        console.log(`✅ Updated ${result.modifiedCount} students with default categories.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

updateDefaults();
