import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { config } from '../config.ts';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    if (!config.database.url) throw new Error('DATABASE_URL no está configurado');
    pool = new pg.Pool({
      connectionString: config.database.url,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Ejecuta `fn` dentro de una transacción, liberando siempre la conexión. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // En producción el .sql se copia junto al build; en dev se lee desde src.
  const candidates = [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'db', 'schema.sql')];
  let sql: string | undefined;
  for (const path of candidates) {
    try {
      sql = await readFile(path, 'utf8');
      break;
    } catch {
      continue;
    }
  }
  if (!sql) throw new Error('No se encontró schema.sql');
  await query(sql);
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
