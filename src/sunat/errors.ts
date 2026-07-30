/**
 * Clasificación de los códigos de respuesta de SUNAT.
 *
 * 0            → aceptado
 * 0100 - 1999  → error de autenticación/configuración (reintentable tras corregir)
 * 2000 - 3999  → comprobante rechazado (no reintentar: hay que corregir y reemitir)
 * 4000 +       → observación (el comprobante fue aceptado con notas)
 */
export type SunatSeverity = 'aceptado' | 'error' | 'rechazado' | 'observacion';

export function clasificar(code: string): SunatSeverity {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'error';
  if (n === 0) return 'aceptado';
  if (n >= 4000) return 'observacion';
  if (n >= 2000) return 'rechazado';
  return 'error';
}

/** Un código de rechazo no debe reintentarse: el XML siempre será inválido. */
export function esReintentable(code: string): boolean {
  const severity = clasificar(code);
  if (severity === 'rechazado') return false;
  // 0100-0999 suelen ser problemas de credenciales o disponibilidad del servicio.
  return severity === 'error';
}

export class SunatError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = esReintentable(code)) {
    super(`[${code}] ${message}`);
    this.name = 'SunatError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Error de transporte (timeout, DNS, 5xx): siempre reintentable. */
export class SunatTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SunatTransportError';
  }
}
