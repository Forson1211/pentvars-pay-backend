import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { config } from './src/config/env';

async function countTemplates() {
    try {
        await mongoose.connect(config.mongoURI);
        const count = await FeeTemplate.countDocuments({});
        const regularCount = await FeeTemplate.countDocuments({ studentType: 'regular' });
        const internationalCount = await FeeTemplate.countDocuments({ studentType: 'international' });
        
        console.log(`Total Fee Templates: ${count}`);
        console.log(`Regular Student Templates: ${regularCount}`);
        console.log(`International Student Templates: ${internationalCount}`);
        
        await mongoose.disconnect();
    } catch (error) {
        console.error('Error counting templates:', error);
    }
}

countTemplates();
