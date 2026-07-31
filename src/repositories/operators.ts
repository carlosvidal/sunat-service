import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.ts';
import { generateApiKey, hashApiKey, verifyApiKey } from '../security/apikey.ts';

export interface OperatorRow {
  operator_id: string;
  nombre: string;
  activo: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OperatorApiKeyRow {
  id: string;
  operator_id: string;
  key_prefix: string;
  label: string | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

/** Resultado de crear una clave: la fila pública + la clave en claro (una sola vez). */
export interface CreatedApiKey extends OperatorApiKeyRow {
  /** Clave completa en claro. Guárdala; no se volverá a mostrar. */
  key: string;
}

/** Operador resuelto tras verificar una clave API. */
export interface VerifiedOperator {
  operator: OperatorRow;
}

export async function createOperator(operatorId: string, nombre: string): Promise<OperatorRow> {
  const { rows } = await query<OperatorRow>(
    `INSERT INTO operators (operator_id, nombre)
     VALUES ($1, $2)
     ON CONFLICT (operator_id) DO UPDATE SET nombre = EXCLUDED.nombre, updated_at = NOW()
     RETURNING *`,
    [operatorId, nombre],
  );
  return rows[0]!;
}

export async function findOperator(operatorId: string): Promise<OperatorRow | null> {
  const { rows } = await query<OperatorRow>('SELECT * FROM operators WHERE operator_id = $1', [operatorId]);
  return rows[0] ?? null;
}

/** Operador con conteo de claves activas (para listados/UI). */
export interface OperatorWithKeys extends OperatorRow {
  claves_activas: number;
}

export async function listOperators(): Promise<OperatorWithKeys[]> {
  const { rows } = await query<OperatorWithKeys>(
    `SELECT o.*, COALESCE(k.claves_activas, 0) AS claves_activas
     FROM operators o
     LEFT JOIN (
       SELECT operator_id, COUNT(*)::int AS claves_activas
       FROM operator_api_keys
       WHERE revoked_at IS NULL
       GROUP BY operator_id
     ) k ON k.operator_id = o.operator_id
     ORDER BY o.created_at DESC`,
  );
  return rows;
}

export async function setOperatorActive(operatorId: string, activo: boolean): Promise<boolean> {
  const { rowCount } = await query(
    'UPDATE operators SET activo = $2, updated_at = NOW() WHERE operator_id = $1',
    [operatorId, activo],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteOperator(operatorId: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM operators WHERE operator_id = $1', [operatorId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Crea una nueva API key para el operador. La clave en claro sólo se devuelve
 * aquí: en BD se guarda el prefijo visible y el hash scrypt. Soporta varias
 * claves activas por operador => rotación con solapamiento.
 */
export async function createApiKey(operatorId: string, label?: string): Promise<CreatedApiKey> {
  const { key, prefix } = generateApiKey();
  const keyHash = await hashApiKey(key);
  const id = randomUUID();
  const { rows } = await query<OperatorApiKeyRow>(
    `INSERT INTO operator_api_keys (id, operator_id, key_prefix, key_hash, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, operator_id, key_prefix, label, last_used_at, created_at, revoked_at`,
    [id, operatorId, prefix, keyHash, label ?? null],
  );
  return { ...rows[0]!, key };
}

export async function listApiKeys(operatorId: string): Promise<OperatorApiKeyRow[]> {
  const { rows } = await query<OperatorApiKeyRow>(
    `SELECT id, operator_id, key_prefix, label, last_used_at, created_at, revoked_at
     FROM operator_api_keys
     WHERE operator_id = $1
     ORDER BY created_at DESC`,
    [operatorId],
  );
  return rows;
}

export async function revokeApiKey(operatorId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE operator_api_keys SET revoked_at = NOW()
     WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL`,
    [keyId, operatorId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Verifica una clave API en claro y resuelve el operador al que pertenece.
 *
 * Estrategia: el prefijo visible acota los candidatos en BD (típicamente 1);
 * luego se verifica scrypt contra cada uno con comparación en tiempo constante.
 * Al acertar, se actualiza `last_used_at`. Devuelve `null` si no hay match.
 */
export async function verifyOperatorApiKey(plainKey: string): Promise<VerifiedOperator | null> {
  if (!plainKey) return null;
  const prefix = plainKey.slice(0, 10);
  // Sólo columnas de claves: acota candidatos por prefijo visible.
  const { rows } = await query<{ id: string; operator_id: string; key_hash: string }>(
    `SELECT id, operator_id, key_hash
     FROM operator_api_keys
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [prefix],
  );

  for (const row of rows) {
    if (!(await verifyApiKey(plainKey, row.key_hash))) continue;
    // Best-effort: actualizar último uso sin fallar la petición.
    await query('UPDATE operator_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
    const operator = await findOperator(row.operator_id);
    if (!operator || !operator.activo) return null;
    return { operator };
  }
  return null;
}

/** Reasigna una empresa a otro operador (sólo super-admin). */
export async function assignOperator(tenantId: string, operatorId: string): Promise<boolean> {
  const { rowCount } = await query(
    'UPDATE tenant_sunat_profiles SET operator_id = $2, updated_at = NOW() WHERE tenant_id = $1',
    [tenantId, operatorId],
  );
  return (rowCount ?? 0) > 0;
}

/** Quita la asignación de operador de una empresa (queda huérfana). */
export async function unassignOperator(tenantId: string): Promise<boolean> {
  const { rowCount } = await query(
    'UPDATE tenant_sunat_profiles SET operator_id = NULL, updated_at = NOW() WHERE tenant_id = $1',
    [tenantId],
  );
  return (rowCount ?? 0) > 0;
}

/** ¿Pertenece la empresa al operador indicado? */
export async function tenantBelongsToOperator(tenantId: string, operatorId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM tenant_sunat_profiles WHERE tenant_id = $1 AND operator_id = $2) AS exists',
    [tenantId, operatorId],
  );
  return rows[0]?.exists ?? false;
}
