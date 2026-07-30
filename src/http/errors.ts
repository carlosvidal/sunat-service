import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { ValidationError } from '../services/emitter.ts';
import { SunatError, SunatTransportError } from '../sunat/errors.ts';

export interface ApiError {
  code: number | string;
  message: string;
  errors?: unknown;
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
  // Violación de unicidad de (tenant, tipo, serie, correlativo).
  if ((err as { code?: string }).code === '23505') {
    return reply.code(409).send({ code: 409, message: 'El comprobante ya fue registrado con esa serie y correlativo' });
  }
  reply.log.error({ err }, 'error no manejado');
  return reply.code(500).send({ code: 500, message });
}
