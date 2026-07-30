import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { config } from './config.ts';
import { BACKOFF_DELAYS_MS, QUEUE_NAME, getConnection, getQueue, type EmisionJob } from './queue/index.ts';
import { findTenant, loadSecrets } from './repositories/tenants.ts';
import {
  consultarTicket, consultarTicketGuia, emitirBaja, emitirGuia,
  emitirResumen, emitirRetPer, emitirVenta,
} from './services/emitter.ts';
import { notify } from './services/webhook.ts';
import { closePool } from './db/pool.ts';
import { SunatError, SunatTransportError } from './sunat/errors.ts';

const log = pino({
  level: config.logLevel,
  transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
});

async function procesar(job: Job<EmisionJob>): Promise<unknown> {
  const data = job.data;
  const tenant = await findTenant(data.tenantId);
  if (!tenant) throw new Error(`Tenant ${data.tenantId} no encontrado`);
  // Los secretos se cargan por job: ningún certificado se comparte entre tenants.
  const secrets = await loadSecrets(tenant);

  switch (data.type) {
    case 'venta': {
      const result = await emitirVenta(tenant, secrets, data.payload, { documentId: data.documentId });
      if (result.state === 'EXCEPCION') {
        // Deja que BullMQ reintente con backoff exponencial.
        throw new SunatTransportError(result.error ?? 'Excepción al enviar a SUNAT');
      }
      await notify(tenant, {
        event: result.state.startsWith('ACEPTADO') ? 'cpe.aceptado' : 'cpe.rechazado',
        tenant_id: tenant.tenant_id,
        ruc: tenant.ruc,
        document_id: result.documentId,
        comprobante: result.fileName,
        state: result.state,
        code: result.cdr?.code,
        description: result.cdr?.description,
        notes: result.cdr?.notes,
      }).catch((err) => log.warn({ err }, 'webhook falló'));
      return { documentId: result.documentId, state: result.state, code: result.cdr?.code };
    }
    case 'resumen':
    case 'baja': {
      const result = data.type === 'resumen'
        ? await emitirResumen(tenant, secrets, data.payload)
        : await emitirBaja(tenant, secrets, data.payload);
      if (!result.ticket) throw new SunatTransportError(result.error ?? 'SUNAT no devolvió ticket');
      // El ticket se consulta luego: SUNAT tarda entre segundos y minutos.
      await getQueue().add('ticket', { type: 'ticket', tenantId: tenant.tenant_id, ticket: result.ticket }, { delay: 60_000 });
      return { summaryId: result.summaryId, ticket: result.ticket };
    }
    case 'retper': {
      const result = await emitirRetPer(tenant, secrets, data.tipo, data.payload, { documentId: data.documentId });
      if (result.state === 'EXCEPCION') {
        throw new SunatTransportError(result.error ?? 'Excepción al enviar a SUNAT');
      }
      await notify(tenant, {
        event: result.state.startsWith('ACEPTADO') ? 'cpe.aceptado' : 'cpe.rechazado',
        tenant_id: tenant.tenant_id,
        ruc: tenant.ruc,
        document_id: result.documentId,
        comprobante: result.fileName,
        state: result.state,
        code: result.cdr?.code,
        description: result.cdr?.description,
        notes: result.cdr?.notes,
      }).catch((err) => log.warn({ err }, 'webhook falló'));
      return { documentId: result.documentId, state: result.state, code: result.cdr?.code };
    }
    case 'guia': {
      const result = await emitirGuia(tenant, secrets, data.payload);
      if (!result.ticket) throw new SunatTransportError(result.error ?? 'SUNAT no devolvió ticket para la guía');
      await getQueue().add('ticket-guia', { type: 'ticket-guia', tenantId: tenant.tenant_id, ticket: result.ticket }, { delay: 30_000 });
      return { documentId: result.documentId, ticket: result.ticket };
    }
    case 'ticket-guia': {
      const result = await consultarTicketGuia(tenant, secrets, data.ticket);
      if (result.procesando) {
        await getQueue().add('ticket-guia', data, { delay: 60_000 });
        return { ticket: data.ticket, procesando: true };
      }
      await notify(tenant, {
        event: result.cdrResponse?.accepted ? 'cpe.aceptado' : 'cpe.rechazado',
        tenant_id: tenant.tenant_id,
        ruc: tenant.ruc,
        ticket: data.ticket,
        state: result.cdrResponse?.accepted ? 'ACEPTADO' : 'RECHAZADO',
        code: result.cdrResponse?.code ?? result.error?.numError,
        description: result.cdrResponse?.description ?? result.error?.desError,
        notes: result.cdrResponse?.notes,
      }).catch((err) => log.warn({ err }, 'webhook falló'));
      return { ticket: data.ticket, code: result.cdrResponse?.code };
    }
    case 'ticket': {
      const result = await consultarTicket(tenant, secrets, data.ticket);
      if (result.procesando) {
        // Aún en proceso: se reprograma la consulta sin marcar el job como fallido.
        await getQueue().add('ticket', data, { delay: 120_000 });
        return { ticket: data.ticket, statusCode: result.statusCode, procesando: true };
      }
      await notify(tenant, {
        event: 'resumen.procesado',
        tenant_id: tenant.tenant_id,
        ruc: tenant.ruc,
        ticket: data.ticket,
        state: result.cdrResponse?.accepted ? 'ACEPTADO' : 'RECHAZADO',
        code: result.cdrResponse?.code,
        description: result.cdrResponse?.description,
        notes: result.cdrResponse?.notes,
      }).catch((err) => log.warn({ err }, 'webhook falló'));
      return { ticket: data.ticket, statusCode: result.statusCode, code: result.cdrResponse?.code };
    }
  }
}

const worker = new Worker<EmisionJob>(QUEUE_NAME, procesar, {
  connection: getConnection(),
  concurrency: config.worker.concurrency,
  settings: {
    // Backoff escalonado: 1 min, 5 min y 15 min.
    backoffStrategy: (attemptsMade) => BACKOFF_DELAYS_MS[Math.min(attemptsMade - 1, BACKOFF_DELAYS_MS.length - 1)]!,
  },
});

worker.on('completed', (job, result) => log.info({ jobId: job.id, result }, 'job completado'));
worker.on('failed', (job, err) => {
  const retryable = !(err instanceof SunatError) || err.retryable;
  log.error({ jobId: job?.id, attempts: job?.attemptsMade, retryable, err: err.message }, 'job falló');
});

log.info({ concurrency: config.worker.concurrency }, 'worker de emisión iniciado');

const shutdown = async () => {
  await worker.close();
  await closePool().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
