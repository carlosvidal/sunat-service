import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.ts';
import type {
  DespatchInput, InvoiceInput, NoteInput, PerceptionInput,
  RetentionInput, SummaryInput, VoidedInput,
} from '../domain/schemas.ts';

export const QUEUE_NAME = 'sunat-emision';

export type EmisionJob =
  | { type: 'venta'; tenantId: string; documentId?: string; payload: InvoiceInput | NoteInput }
  | { type: 'resumen'; tenantId: string; payload: SummaryInput }
  | { type: 'baja'; tenantId: string; payload: VoidedInput }
  | { type: 'guia'; tenantId: string; payload: DespatchInput }
  | { type: 'retper'; tipo: '20' | '40'; tenantId: string; documentId?: string; payload: RetentionInput | PerceptionInput }
  | { type: 'ticket'; tenantId: string; ticket: string }
  | { type: 'ticket-guia'; tenantId: string; ticket: string };

/**
 * Reintentos exponenciales: 1 min, 5 min y 15 min aproximados. SUNAT presenta
 * latencias e indisponibilidades frecuentes, y el flujo de venta no debe
 * bloquearse por ello.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'sunat' },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export const BACKOFF_DELAYS_MS = [60_000, 300_000, 900_000];

let connection: Redis | undefined;
let queue: Queue<EmisionJob> | undefined;

export function redisEnabled(): boolean {
  return Boolean(config.redis.url);
}

export function getConnection(): Redis {
  if (!config.redis.url) throw new Error('REDIS_URL no está configurado: la emisión asíncrona está deshabilitada');
  connection ??= new Redis(config.redis.url, { maxRetriesPerRequest: null });
  return connection;
}

export function getQueue(): Queue<EmisionJob> {
  queue ??= new Queue<EmisionJob>(QUEUE_NAME, { connection: getConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return queue;
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
  connection?.disconnect();
  connection = undefined;
}
