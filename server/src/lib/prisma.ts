import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env';

/**
 * Single client for the process. Reusing the instance matters on serverless-style
 * hosts where a cold start per request would otherwise open a new pool each time;
 * here it mainly keeps `tsx watch` from leaking connections during development.
 */
export const prisma = new PrismaClient({
  log: isProd ? ['error'] : ['error', 'warn'],
});
