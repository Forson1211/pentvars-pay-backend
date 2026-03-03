# PentVars Pay Backend API

This is a Node.js + Express + MongoDB backend for the PentVars Pay application.

## Prerequisites

- **Node.js** (v14+)
- **MongoDB** (v4.0+) running locally on port 27017

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Seed the database with initial data:
   ```bash
   npm run seed
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

## Configuration

Environment variables are stored in `.env`. The default configuration connects to a local MongoDB instance:
```
MONGODB_URI=mongodb://127.0.0.1:27017/pentvars-pay
```

## API Documentation

The server runs at `http://localhost:5000`.

- **POST /api/auth/register**: Register a new student
- **POST /api/auth/login**: Login student or admin
- **GET /api/fees/student**: Get fees for the logged-in student
- **POST /api/payments/initiate**: Make a payment

## Project Structure

- `src/controllers`: Request handlers
- `src/models`: Mongoose schemas
- `src/routes`: API route definitions
- `src/middleware`: Auth and error handling middleware
- `src/services`: Business logic (if separated from controllers)
