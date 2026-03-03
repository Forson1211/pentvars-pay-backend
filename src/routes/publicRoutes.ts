import { Router } from 'express';
import {
    getPublicFaculties,
    getPublicProgrammes,
    getFeePreview,
} from '../controllers/publicController';

const router = Router();

// All public routes — no authentication required
router.get('/faculties', getPublicFaculties);
router.get('/programmes', getPublicProgrammes);
router.post('/fee-preview', getFeePreview);

export default router;
