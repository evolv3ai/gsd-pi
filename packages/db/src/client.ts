// packages/db — Drizzle ORM client singleton using neon-http driver.
// Uses HTTP transport (not TCP pool) — correct for Next.js serverless API routes (D-05, D-06).
// Per Pattern 3 from RESEARCH.md: drizzle({ client: sql, schema }) with schema passed for type-safe queries.
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema/index.js';

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle({ client: sql, schema });
