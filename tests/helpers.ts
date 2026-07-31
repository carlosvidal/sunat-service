/**
 * Helper de integración para los tests HTTP/BD.
 *
 * No existe harness previo en el repo (los tests actuales son puros unit).
 * Aquí arrancamos `buildApp()`, migramos una BD de test aislada y exponemos
 * utilidades para crear operadores/empresas vía la propia API.
 *
 * Uso: el test debe `import`ar este módulo ANTES de cualquier import que
 * cargue `config` (que lee env al importarse). El bloque `setupEnv()` del
 * consumidor debe ejecutarse primero, o bien este helper fija env por defecto.
 */
import { after, before, beforeEach } from 'node:test';
import type { FastifyInstance } from 'fastify';

const TEST_DB = process.env.SUNAT_TEST_DB ?? 'sunat_test';
const PG_ADMIN_URL = process.env.SUNAT_TEST_ADMIN_URL ?? 'postgres://sunat:sunat@localhost:5434/postgres';
export const TEST_DATABASE_URL = `postgres://sunat:sunat@localhost:5434/${TEST_DB}`;

export interface IntegrationCtx {
  app: FastifyInstance | null;
  masterKey: string;
  /** false cuando no hay Postgres disponible: la suite se salta limpiamente. */
  disponible: boolean;
}

/** Intenta conectar a Postgres; resuelve false si no está disponible. */
async function postgresDisponible(): Promise<boolean> {
  try {
    const { Client } = await import('pg');
    const c = new Client(PG_ADMIN_URL);
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

/** Crea la BD de test limpia y aplica el esquema. Llamar una vez por suite. */
async function resetTestDatabase(): Promise<void> {
  const { Client } = await import('pg');
  const admin = new Client(PG_ADMIN_URL);
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  // Importar pool/migrate tras apuntar env a la BD de test.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_SSL = 'false';
  const { migrate, closePool } = await import('../src/db/pool.ts');
  await migrate();
  await closePool();
}

/**
 * Suite base: arranca app con env de test fijado y la cierra al terminar.
 * Si no hay Postgres disponible, marca `ctx.disponible = false` y los tests
 * deben saltarse (útil en CI sin servicio de BD en el job de pruebas).
 */
export function setupIntegrationSuite(ctx: IntegrationCtx): void {
  before(async function () {
    // Env debe fijarse antes del primer import de config/app.
    process.env.NODE_ENV = 'test';
    process.env.MASTER_API_KEY = 'test-master-key';
    process.env.JWT_SECRET = 'test-jwt-secret';
    // Clave de cifrado AES-256-GCM para los secretos de empresas en tests
    // (32 bytes en base64). Requerida por upsertTenant al crear empresas.
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.LOG_LEVEL = 'error';
    ctx.disponible = await postgresDisponible();
    if (!ctx.disponible) {
      // No hay BD: la suite se saltará. No instanciamos la app.
      return;
    }
    await resetTestDatabase();
    const { buildApp } = await import('../src/app.ts');
    ctx.app = await buildApp();
    ctx.masterKey = process.env.MASTER_API_KEY!;
  });

  after(async () => {
    if (ctx.app) await ctx.app.close();
    const { closePool } = await import('../src/db/pool.ts');
    await closePool().catch(() => {});
  });
}

/**
 * Crea un operador vía API de super-admin y le genera una API key.
 * Devuelve `{ operatorId, key }` para usar en cabeceras `X-Operator-Key`.
 */
export async function createOperatorWithKey(
  app: FastifyInstance,
  masterKey: string,
  operatorId: string,
  nombre = `Operador ${operatorId}`,
): Promise<{ operatorId: string; key: string }> {
  await app.inject({
    method: 'POST',
    url: '/api/v1/operators',
    headers: { 'x-api-key': masterKey },
    payload: { operator_id: operatorId, nombre },
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/operators/${operatorId}/keys`,
    headers: { 'x-api-key': masterKey },
    payload: { label: 'test' },
  });
  const body = res.json() as { key: string };
  return { operatorId, key: body.key };
}

/** Limpia tablas entre tests para que no haya fuga de estado. */
export function cleanTablesBeforeEach(ctx?: IntegrationCtx): void {
  beforeEach(async function () {
    if (ctx && !ctx.disponible) this.skip();
    const { query } = await import('../src/db/pool.ts');
    await query('DELETE FROM electronic_documents');
    await query('DELETE FROM summary_documents');
    await query('DELETE FROM document_series');
    await query('DELETE FROM tenant_sunat_profiles');
    await query('DELETE FROM operator_api_keys');
    await query('DELETE FROM operators');
  });
}
