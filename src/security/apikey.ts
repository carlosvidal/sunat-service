import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Hashing de las API keys de operador con scrypt (node:crypto, sin dependencias
 * nativas). Las claves se verifican por petición en `/companies`, de baja
 * frecuencia, así que los parámetros elegidos equilibran seguridad y latencia.
 *
 * El hash se serializa en un formato autocontenido (tipo PHC) para que cambios
 * futuros de parámetros no requieran migrar datos:
 *   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
 */

const PREFIX = 'skop_';
const KEY_LEN = 32;
const N = 2 ** 15; // CPU/memory cost (32 MiB)
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024; // 64 MiB

/** Longitud del prefijo visible que identifica la clave en la BD/UI. */
export const VISIBLE_PREFIX_LEN = 10;

/** Genera una clave opaca `skop_<random>` de ~43 chars y su prefijo visible. */
export function generateApiKey(): { key: string; prefix: string } {
  const random = randomBytes(32).toString('base64url');
  const key = PREFIX + random;
  // El prefijo visible son los primeros caracteres tras `skop_`.
  const prefix = key.slice(0, VISIBLE_PREFIX_LEN);
  return { key, prefix };
}

export async function hashApiKey(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(Buffer.from(plain), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyApiKey(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const nStr = parts[1];
  const rStr = parts[2];
  const pStr = parts[3];
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
  const N0 = Number(nStr);
  const r0 = Number(rStr);
  const p0 = Number(pStr);
  if (!Number.isInteger(N0) || !Number.isInteger(r0) || !Number.isInteger(p0)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const derived = await scrypt(Buffer.from(plain), salt, KEY_LEN, {
    N: N0,
    r: r0,
    p: p0,
    maxmem: MAXMEM,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
