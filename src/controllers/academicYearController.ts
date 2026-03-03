import { Request, Response, NextFunction } from 'express';
import { AcademicYear } from '../models/AcademicYear';

/**
 * POST /api/admin/academic-year
 * Admin: Create a new academic year
 */
export const createAcademicYear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { yearLabel, startDate, endDate, isActive } = req.body;

        if (!yearLabel) {
            res.status(400).json({ message: 'Year label is required (e.g. "2024/2025").' });
            return;
        }

        // Check for duplicate
        const existing = await AcademicYear.findOne({ yearLabel });
        if (existing) {
            res.status(400).json({ message: `Academic year "${yearLabel}" already exists.` });
            return;
        }

        const academicYear = await AcademicYear.create({
            yearLabel,
            startDate,
            endDate,
            isActive: isActive || false,
            createdBy: req.user!._id,
        });

        res.status(201).json(academicYear.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/academic-years
 * Admin: Get all academic years
 */
export const getAllAcademicYears = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const years = await AcademicYear.find({}).sort({ createdAt: -1 });
        res.json(years);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/admin/academic-year/active
 * Get the currently active academic year (accessible to authenticated users)
 */
export const getActiveAcademicYear = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (!activeYear) {
            res.status(404).json({ message: 'No active academic year found.' });
            return;
        }
        res.json(activeYear.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/academic-year/:id/activate
 * Admin: Activate an academic year (deactivates all others)
 */
export const activateAcademicYear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const academicYear = await AcademicYear.findById(id);
        if (!academicYear) {
            res.status(404).json({ message: 'Academic year not found.' });
            return;
        }

        // Deactivate all others first
        await AcademicYear.updateMany(
            { _id: { $ne: id } },
            { $set: { isActive: false } }
        );

        // Activate this one
        academicYear.isActive = true;
        await academicYear.save();

        res.json({
            message: `Academic year "${academicYear.yearLabel}" is now active.`,
            academicYear: academicYear.toJSON(),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/admin/academic-year/:id
 * Admin: Update an academic year
 */
export const updateAcademicYear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { yearLabel, startDate, endDate } = req.body;

        const academicYear = await AcademicYear.findById(id);
        if (!academicYear) {
            res.status(404).json({ message: 'Academic year not found.' });
            return;
        }

        if (yearLabel) academicYear.yearLabel = yearLabel;
        if (startDate) academicYear.startDate = startDate;
        if (endDate) academicYear.endDate = endDate;

        await academicYear.save();

        res.json(academicYear.toJSON());
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/admin/academic-year/:id
 * Admin: Delete an academic year (only if not active)
 */
export const deleteAcademicYear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const academicYear = await AcademicYear.findById(id);
        if (!academicYear) {
            res.status(404).json({ message: 'Academic year not found.' });
            return;
        }

        if (academicYear.isActive) {
            res.status(400).json({ message: 'Cannot delete the active academic year. Activate another year first.' });
            return;
        }

        await AcademicYear.findByIdAndDelete(id);
        res.json({ message: `Academic year "${academicYear.yearLabel}" deleted.` });
    } catch (error) {
        next(error);
    }
};
