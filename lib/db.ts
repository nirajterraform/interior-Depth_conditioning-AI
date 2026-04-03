import { Pool } from "pg";

declare global {
  // Prevent multiple pools during Next.js dev hot reload
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createPool(): Pool {
  return new Pool({
    host: requiredEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requiredEnv("PGDATABASE"),
    user: requiredEnv("PGUSER"),
    password: requiredEnv("PGPASSWORD"),
    ssl: {
      rejectUnauthorized: false,
    },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const db: Pool = global.__pgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  global.__pgPool = db;
}

export async function testDbConnection() {
  const client = await db.connect();
  try {
    const result = await client.query<{
      now: string;
      current_database: string;
      user_name: string;
      products_count: string;
    }>(`
      SELECT
        NOW()::text AS now,
        current_database()::text AS current_database,
        current_user::text AS user_name,
        (SELECT COUNT(*) FROM products)::text AS products_count
    `);

    return result.rows[0];
  } finally {
    client.release();
  }
}