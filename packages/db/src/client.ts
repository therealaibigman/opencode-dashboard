import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export function makeDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  return { db, pool };
}
