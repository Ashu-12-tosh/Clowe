import { PrismaClient } from '@prisma/client';

// Single PrismaClient instance shared across the app.
export const prisma = new PrismaClient();
