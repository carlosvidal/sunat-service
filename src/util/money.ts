/**
 * Utilidades numéricas. SUNAT exige importes con 2 decimales y valores
 * unitarios con hasta 10 decimales, sin notación científica.
 */

/** Redondeo "half away from zero" evitando errores de coma flotante. */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // El epsilon corrige casos como 1.005 * 100 = 100.49999999999999
  const scaled = value * factor;
  const corrected = scaled + (scaled >= 0 ? Number.EPSILON * Math.abs(scaled) : -Number.EPSILON * Math.abs(scaled));
  return Math.round(corrected) / factor;
}

/** Formato de importe con decimales fijos (por defecto 2). */
export function fmt(value: number | null | undefined, decimals = 2): string {
  return round(value ?? 0, decimals).toFixed(decimals);
}

/**
 * Formato con decimales variables: mínimo 2, máximo `limit`.
 * Equivale al `n_format_limit` de Greenter para valores unitarios.
 */
export function fmtLimit(value: number | null | undefined, limit = 10): string {
  const v = round(value ?? 0, limit);
  const fixed = v.toFixed(limit);
  const trimmed = fixed.replace(/0+$/, '');
  const [int, dec = ''] = trimmed.split('.');
  if (dec.length <= 2) return `${int}.${dec.padEnd(2, '0')}`;
  return `${int}.${dec}`;
}

/** Suma segura de una lista de importes redondeando al final. */
export function sum(values: Array<number | null | undefined>, decimals = 2): number {
  return round(values.reduce<number>((acc, v) => acc + (v ?? 0), 0), decimals);
}
