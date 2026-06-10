import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { FeeTemplate } from './src/models/FeeTemplate';
import { Faculty } from './src/models/Faculty';
import { Programme } from './src/models/Programme';
import { config } from './src/config/env';

async function diagnose() {
    try {
        await mongoose.connect(config.mongoURI);
        console.log('Connected to:', config.mongoURI);

        const total = await FeeTemplate.countDocuments({});
        const regular = await FeeTemplate.countDocuments({ studentType: 'regular' });
        const weekend = await FeeTemplate.countDocuments({ studentType: 'weekend' });
        const intl = await FeeTemplate.countDocuments({ studentType: 'international' });
        const facCount = await Faculty.countDocuments({});
        const progCount = await Programme.countDocuments({});

        console.log('--- DB Counts ---');
        console.log('Faculties:', facCount);
        console.log('Programmes:', progCount);
        console.log('Total Templates:', total);
        console.log('Regular:', regular);
        console.log('Weekend:', weekend);
        console.log('International:', intl);
        console.log('');

        // Check if there's a faculty ObjectId issue 
        const sample = await FeeTemplate.findOne({ studentType: 'regular' }).populate('faculty').populate('programme').lean();
        if (sample) {
            console.log('Sample regular template:');
            console.log('  faculty type:', typeof (sample as any).faculty);
            console.log('  faculty value:', JSON.stringify((sample as any).faculty)?.substring(0, 120));
            console.log('  programme:', JSON.stringify((sample as any).programme)?.substring(0, 80));
            console.log('  level:', (sample as any).level);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

diagnose();
