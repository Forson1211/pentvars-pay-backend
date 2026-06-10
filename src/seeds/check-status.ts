import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { User } from '../models/User';
import { config } from '../config/env';

async function restoreDefaultStatus() {
    await mongoose.connect(config.mongoURI);
    
    // 1. Ensure the user's account password is reset to something he can use if he lost the original
    // But better yet, I should tell him what it is.
    // I will set it to 'pentvars2026' for him to recover if needed.
    
    const forson = await User.findOne({ email: 'puit22217120@pentvars.edu.gh' });
    if (forson) {
        console.log('Forson account found.');
        // We cannot restore his original password, but we can ensure his status is active.
        forson.status = 'active';
        await forson.save();
    }

    const allUsers = await User.find({});
    console.log('Current users:', allUsers.map(u => ({ email: u.email, avatar: u.avatarUrl, role: u.role })));
    
    await mongoose.disconnect();
}

restoreDefaultStatus();
