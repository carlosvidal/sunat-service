import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { ValidationError } from '../services/emitter.ts';
import { SunatError, SunatTransportError } from '../sunat/errors.ts';

export interface ApiError {
  code: number | string;
  message: string;
  errors?: unknown;
}

/**
 * Error de validación de los datos/certificado de una empresa emisora (alta o
 * actualización). Se traduce a HTTP 400 para que el integrador distinga "los
 * datos que enviaste están mal" de un error interno del servidor (500).
 *
 * `code` es un string identificable que el integrador puede inspeccionar:
 *   - 'invalid_certificate': el .pfx/PEM no abre, está corrupto o sin llave.
 *   - 'ruc_mismatch': el RUC del subject del certificado ≠ RUC declarado.
 */
export class InvalidTenantInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvalidTenantInputError';
    this.code = code;
  }
}

/** Traduce las excepciones del dominio a respuestas HTTP consistentes. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      code: 400,
      message: 'Payload inválido',
      errors: err.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    });
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({ code: 400, message: 'Comprobante inválido', errors: err.errors });
  }
  if (err instanceof SunatError) {
    return reply.code(422).send({ code: err.code, message: err.message, retryable: err.retryable });
  }
  if (err instanceof SunatTransportError) {
    return reply.code(503).send({ code: 503, message: err.message, retryable: true });
  }
  const message = (err as Error)?.message ?? 'Error interno';
  if ((err as { code?: string }).code === '23505') {
    // Hay dos índices únicos que pueden saltar aquí y significan cosas distintas.
    // Sin discriminar, una carrera de idempotencia se reportaría como un choque
    // de correlativo, que es falso y despista al integrador.
    if ((err as { constraint?: string }).constraint === 'uq_documents_idempotency') {
      return reply.code(409).send({
        code: 409,
        message: 'Hay una emisión en curso con esa clave de idempotencia',
        retryable: true,
      });
    }
    // Violación de unicidad de (tenant, tipo, serie, correlativo).
    return reply.code(409).send({ code: 409, message: 'El comprobante ya fue registrado con esa serie y correlativo' });
  }
  if (err instanceof InvalidTenantInputError) {
    // Datos/certificado de empresa inválidos: falla del cliente (400), no del
    // servidor. Se loguea a warn para mantener observabilidad sin ruido.
    reply.log.warn({ code: err.code }, 'datos de empresa inválidos');
    return reply.code(400).send({ code: err.code, message: err.message });
  }
  reply.log.error({ err }, 'error no manejado');
  return reply.code(500).send({ code: 500, message });
}
