import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { User } from '../models/User';
import { Programme } from '../models/Programme';

const repair = async () => {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error('❌ MONGODB_URI is not defined in .env');
            process.exit(1);
        }

        console.log('🌱 Connecting to database...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB.');

        // 1. Repair AB Koranteng
        const abUser = await User.findOne({ email: 'ab@gmail.com' });
        if (abUser) {
            console.log(`👤 Found student AB Koranteng. Current programmeRef: ${abUser.programmeRef}`);
            // Find correct BSc. Architecture programme
            const archProg = await Programme.findOne({ programmeName: 'BSc. Architecture' });
            if (archProg) {
                abUser.programmeRef = archProg._id;
                await abUser.save();
                console.log(`✅ Updated AB Koranteng's programmeRef to: ${archProg._id} (${archProg.programmeName})`);
            } else {
                console.error('❌ BSc. Architecture programme not found in DB!');
            }
        } else {
            console.warn('⚠️ Student AB Koranteng not found by email ab@gmail.com');
        }

        // 2. Repair Ama Serwaa
        const amaUser = await User.findOne({ email: 'ama.serwaa@pentvarsuniversity.edu.gh' });
        if (amaUser) {
            console.log(`👤 Found student Ama Serwaa. Current programme: ${amaUser.programme}, programmeRef: ${amaUser.programmeRef}`);
            // Find BSc. Accounting programme
            const accProg = await Programme.findOne({ programmeName: 'BSc. Accounting' });
            if (accProg) {
                amaUser.programme = 'BSc. Accounting';
                amaUser.programmeRef = accProg._id;
                await amaUser.save();
                console.log(`✅ Updated Ama Serwaa's programme to ${amaUser.programme} and programmeRef to: ${accProg._id}`);
            } else {
                console.error('❌ BSc. Accounting programme not found in DB!');
            }
        } else {
            console.warn('⚠️ Student Ama Serwaa not found by email ama.serwaa@pentvarsuniversity.edu.gh');
        }

        console.log('🎉 Repair complete!');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Error executing repair:', err);
        process.exit(1);
    }
};

repair();
