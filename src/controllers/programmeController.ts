import { Request, Response, NextFunction } from 'express';
import { Programme } from '../models/Programme';

/**
 * POST /api/admin/programme
 * Admin: Create a new programme
 */
export const createProgramme = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { faculty, programmeName, code, duration } = req.body;

        if (!faculty || !programmeName) {
            res.status(400).json({ message: 'Faculty and programme name are required.' });
            return;
        }

        const programme = await Programme.create({
            faculty,
            programmeName,
            code,
            duration,
        });

        res.status(201).json(programme.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/programmes
 * Get all programmes (accessible to admins and students for dropdown selections)
 */
export const getAllProgrammes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { faculty, isActive } = req.query;
        const filter: Record<string, any> = {};

        if (faculty) filter.faculty = faculty;
        if (isActive !== undefined) filter.isActive = isActive === 'true';

        const programmes = await Programme.find(filter).populate('faculty', 'name code').sort({ programmeName: 1 });
        res.json(programmes);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/programme/:id
 * Get a single programme
 */
export const getProgrammeById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const programme = await Programme.findById(req.params.id);
        if (!programme) {
            res.status(404).json({ message: 'Programme not found.' });
            return;
        }
        res.json(programme.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/programme/:id
 * Admin: Update a programme
 */
export const updateProgramme = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { faculty, programmeName, code, duration, isActive } = req.body;

        const programme = await Programme.findById(req.params.id);
        if (!programme) {
            res.status(404).json({ message: 'Programme not found.' });
            return;
        }

        if (faculty) programme.faculty = faculty;
        if (programmeName) programme.programmeName = programmeName;
        if (code !== undefined) programme.code = code;
        if (duration !== undefined) programme.duration = duration;
        if (isActive !== undefined) programme.isActive = isActive;

        await programme.save();
        res.json(programme.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/programme/:id
 * Admin: Delete a programme
 */
export const deleteProgramme = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const programme = await Programme.findById(req.params.id);
        if (!programme) {
            res.status(404).json({ message: 'Programme not found.' });
            return;
        }

        await Programme.findByIdAndDelete(req.params.id);
        res.json({ message: `Programme "${programme.programmeName}" deleted.` });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/programmes/faculties
 * Get distinct faculties
 */
export const getDistinctFaculties = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const faculties = await Programme.distinct('faculty', { isActive: true });
        res.json(faculties.sort());
    } catch (error) {
        next(error);
    }
};
