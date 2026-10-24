// Runs BEFORE test files, in each worker: point Prisma at the test database.
process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./test.db";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-only";
process.env.DEMO_MODE = "false";
