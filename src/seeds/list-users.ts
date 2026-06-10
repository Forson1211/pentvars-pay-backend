import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { User } from '../models/User';
import { config } from '../config/env';

async function listAllUsers() {
    await mongoose.connect(config.mongoURI);
    const users = await User.find({});
    console.log(JSON.stringify(users.map(u => u.toJSON()), null, 2));
    await mongoose.disconnect();
}

listAllUsers();
