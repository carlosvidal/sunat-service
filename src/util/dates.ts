/**
 * Manejo de fechas en zona horaria de Perú (UTC-5, sin DST).
 * SUNAT valida la fecha de emisión contra la hora peruana, por lo que nunca
 * se debe usar la zona horaria del servidor.
 */
const PERU_OFFSET_MS = -5 * 60 * 60 * 1000;

function toPeru(date: Date): Date {
  return new Date(date.getTime() + PERU_OFFSET_MS);
}

/** Fecha en formato YYYY-MM-DD respetando el offset del input o Perú. */
export function isoDate(value: string | Date): string {
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (m) return m[1]!;
    value = new Date(value);
  }
  return toPeru(value).toISOString().slice(0, 10);
}

/** Hora en formato HH:mm:ss respetando el offset del input o Perú. */
export function isoTime(value: string | Date): string {
  if (typeof value === 'string') {
    const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}:\d{2})/.exec(value);
    if (m) return m[1]!;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return '00:00:00';
    value = new Date(value);
  }
  return toPeru(value).toISOString().slice(11, 19);
}

/** Fecha actual (YYYY-MM-DD) en Perú. */
export function todayPeru(): string {
  return toPeru(new Date()).toISOString().slice(0, 10);
}

/** Compacta YYYY-MM-DD a YYYYMMDD (usado en los IDs de RC/RA). */
export function compactDate(value: string | Date): string {
  return isoDate(value).replace(/-/g, '');
}
