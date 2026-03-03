import { Request, Response, NextFunction } from 'express';
import { Faculty } from '../models/Faculty';
import { Programme } from '../models/Programme';
import { FeeTemplate } from '../models/FeeTemplate';

/**
 * POST /api/admin/faculty
 * Admin: Create a new faculty
 */
export const createFaculty = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { name, code } = req.body;

        if (!name) {
            res.status(400).json({ message: 'Faculty name is required.' });
            return;
        }

        const existing = await Faculty.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (existing) {
            res.status(400).json({ message: 'A faculty with this name already exists.' });
            return;
        }

        const faculty = await Faculty.create({ name, code });
        res.status(201).json(faculty);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/faculties
 * Admin: Get all faculties
 */
export const getAllFaculties = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const faculties = await Faculty.find().sort({ name: 1 });
        res.json(faculties);
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/faculty/:id
 * Admin: Update a faculty
 */
export const updateFaculty = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const faculty = await Faculty.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true, runValidators: true }
        );
        if (!faculty) {
            res.status(404).json({ message: 'Faculty not found.' });
            return;
        }
        res.json(faculty);
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/faculty/:id
 * Admin: Delete a faculty (only if no programmes attached)
 */
export const deleteFaculty = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const programmeCount = await Programme.countDocuments({ faculty: req.params.id });
        if (programmeCount > 0) {
            res.status(400).json({ message: `Cannot delete faculty — ${programmeCount} programme(s) still belong to it.` });
            return;
        }
        const faculty = await Faculty.findByIdAndDelete(req.params.id);
        if (!faculty) {
            res.status(404).json({ message: 'Faculty not found.' });
            return;
        }
        res.json({ message: 'Faculty deleted successfully.' });
    } catch (error) {
        next(error);
    }
};
