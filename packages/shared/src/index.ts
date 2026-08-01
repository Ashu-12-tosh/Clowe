import { z } from 'zod';

/**
 * User roles across the platform. A single users table with a role field
 * drives permissions for customers, sellers, and admins.
 */
export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  SELLER: 'SELLER',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Standard envelope every API response uses. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Health-check response returned by GET /api/health. */
export * from './auth';
export * from './catalog';
export * from './seller';
export * from './admin';
export * from './checkout';
export * from './tryon';
export * from './ai';
export * from './growth';
export * from './complaints';
export * from './settings';
export * from './home';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.string(),
  database: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
