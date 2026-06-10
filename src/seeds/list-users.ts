import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { User } from '../models/User';
import { config } from '../config/env';

async function listAllUsers() {
    await mongoose.connect(config.mongoURI);
    const users = await User.find({}, 'email firstName lastName role studentId status');
    console.log(JSON.stringify(users, null, 2));
    await mongoose.disconnect();
}

listAllUsers();
