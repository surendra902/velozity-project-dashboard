import 'dotenv/config';
import { z } from 'zod';

// Fail fast and loudly at boot rather than discovering a missing secret
// on the first request that needs it.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Distinct secrets so a leaked access secret cannot mint refresh tokens.
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),

  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // z.coerce.boolean() would read the string "false" as true, so compare explicitly.
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately writes to stderr and exits: a misconfigured server should not
  // accept a single request.
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
