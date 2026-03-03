import { Request, Response, NextFunction } from 'express';

/**
 * Global error handler middleware
 */
export const errorHandler = (
    err: Error & { statusCode?: number; code?: number },
    _req: Request,
    res: Response,
    _next: NextFunction
): void => {
    console.error('❌ Error:', err.message);

    let statusCode = err.statusCode || 500;
    let message = err.message || 'Internal Server Error';

    // MongoDB duplicate key error
    if (err.code === 11000) {
        statusCode = 400;
        message = 'Duplicate entry. This record already exists.';
    }

    // MongoDB validation error
    if (err.name === 'ValidationError') {
        statusCode = 400;
    }

    // MongoDB cast error (invalid ObjectId)
    if (err.name === 'CastError') {
        statusCode = 400;
        message = 'Invalid ID format.';
    }

    res.status(statusCode).json({
        success: false,
        message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
};

/**
 * Not found handler
 */
export const notFound = (req: Request, res: Response): void => {
    res.status(404).json({
        success: false,
        message: `Route not found: ${req.method} ${req.originalUrl}`,
    });
};
