import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listarDocumentosAdmin, listarResumenesAdmin, obtenerDocumento, resumenAdmin,
  type AdminDocumentRow, type SunatState,
} from '../../repositories/documents.ts';
import { findTenant, listTenants, loadSecrets, toPublic } from '../../repositories/tenants.ts';
import { listOperators } from '../../repositories/operators.ts';
import { emitirRetPer, emitirVenta } from '../../services/emitter.ts';
import { getStorage } from '../../storage/index.ts';
import { getQueue, redisEnabled } from '../../queue/index.ts';
import { invoiceSchema, noteSchema, perceptionSchema, retentionSchema } from '../../domain/schemas.ts';
import { respuesta } from '../openapi.ts';
import { sendError } from '../errors.ts';

const ESTADOS = [
  'PENDIENTE', 'EN_COLA_SUNAT', 'ACEPTADO', 'ACEPTADO_CON_OBSERVACIONES',
  'RECHAZADO', 'EXCEPCION', 'ANULADO',
] as const;

const filtros = z.object({
  tenant_id: z.string().optional(),
  state: z.enum(ESTADOS).optional(),
  tipo: z.string().optional(),
  q: z.string().optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

function toRow(row: AdminDocumentRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    ruc: row.ruc,
    razon_social: row.razon_social,
    tipo_comprobante: row.tipo_comprobante,
    comprobante: `${row.serie}-${row.correlativo}`,
    nombre_archivo: row.nombre_archivo,
    fecha_emision: row.fecha_emision,
    cliente: row.cliente_razon_social,
    cliente_num_doc: row.cliente_num_doc,
    moneda: row.moneda,
    monto_total: Number(row.monto_total),
    state: row.sunat_state,
    sunat_code: row.sunat_code,
    sunat_description: row.sunat_description,
    sunat_notes: row.sunat_notes,
    ticket: row.ticket,
    retry_count: row.retry_count,
    last_error: row.last_error,
    files: { xml: row.xml_path, cdr: row.cdr_path, pdf: row.pdf_path },
    created_at: row.created_at,
  };
}

/** Tipos de comprobante que pueden reintentarse con el payload almacenado. */
const REINTENTABLES = {
  '01': invoiceSchema,
  '03': invoiceSchema,
  '07': noteSchema,
  '08': noteSchema,
  '20': retentionSchema,
  '40': perceptionSchema,
} as const;

/**
 * API del backoffice: monitoreo transversal a todas las empresas y operaciones
 * manuales (reintento de un comprobante, inspección de la cola).
 * Protegida con la clave maestra de la plataforma.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireMasterKey);
  const seguridad = [{ apiKey: [] }];

  app.get('/admin/overview', {
    schema: {
      tags: ['backoffice'],
      summary: 'Resumen de emisión',
      description: 'Totales por estado y por tipo de comprobante, últimos errores y empresas registradas.',
      security: seguridad,
      response: { 200: respuesta('Resumen para el tablero.') },
    },
  }, async (req, reply) => {
    try {
      const f = filtros.parse(req.query);
      const [resumen, tenants, resumenes, operators] = await Promise.all([
        resumenAdmin({ tenantId: f.tenant_id, desde: f.desde, hasta: f.hasta, state: f.state as SunatState | undefined }),
        listTenants(),
        listarResumenesAdmin(f.tenant_id, 15),
        listOperators(),
      ]);
      const operatorName = new Map(operators.map((o) => [o.operator_id, o.nombre]));
      return reply.send({
        ...resumen,
        empresas: tenants.map((t) => ({
          ...toPublic(t),
          operator: t.operator_id ? { operator_id: t.operator_id, nombre: operatorName.get(t.operator_id) ?? null } : null,
        })),
        resumenes: resumenes.map((r) => ({
          id: r.id,
          tipo: r.tipo,
          nombre_archivo: r.nombre_archivo,
          fecha_referencia: r.fecha_referencia,
          ticket: r.ticket,
          state: r.sunat_state,
          sunat_code: r.sunat_code,
          sunat_description: r.sunat_description,
        })),
        cola_habilitada: redisEnabled(),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/admin/documents', {
    schema: {
      tags: ['backoffice'],
      summary: 'Buscar comprobantes de todas las empresas',
      description: 'Filtra por empresa, estado, tipo, rango de fechas y texto libre (serie-correlativo, RUC o razón social del cliente).',
      security: seguridad,
      querystring: {
        type: 'object',
        properties: {
          tenant_id: { type: 'string' },
          state: { type: 'string', enum: [...ESTADOS] },
          tipo: { type: 'string', description: 'Tipo de comprobante (01, 03, 07, 08, 09, 20, 40).' },
          q: { type: 'string', description: 'Búsqueda libre.' },
          desde: { type: 'string' },
          hasta: { type: 'string' },
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
      response: { 200: respuesta('Comprobantes encontrados y total.') },
    },
  }, async (req, reply) => {
    try {
      const f = filtros.parse(req.query);
      const { rows, total } = await listarDocumentosAdmin({
        tenantId: f.tenant_id,
        state: f.state as SunatState | undefined,
        tipo: f.tipo,
        q: f.q,
        desde: f.desde,
        hasta: f.hasta,
        limit: f.limit,
        offset: f.offset,
      });
      return reply.send({ total, limit: f.limit, offset: f.offset, items: rows.map(toRow) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/admin/documents/:id', {
    schema: {
      tags: ['backoffice'],
      summary: 'Detalle de un comprobante',
      description: 'Incluye el payload original con el que se emitió, para diagnosticar rechazos.',
      security: seguridad,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: respuesta('Detalle.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await obtenerDocumento(id);
    if (!row) return reply.code(404).send({ code: 404, message: 'Documento no encontrado' });
    const tenant = await findTenant(row.tenant_id);
    return reply.send({
      ...toRow({ ...row, ruc: tenant?.ruc ?? '', razon_social: tenant?.razon_social ?? '' }),
      payload: row.payload,
    });
  });

  app.get('/admin/documents/:id/:tipo', {
    schema: {
      tags: ['backoffice'],
      summary: 'Descargar un artefacto',
      security: seguridad,
      params: {
        type: 'object',
        required: ['id', 'tipo'],
        properties: { id: { type: 'string' }, tipo: { type: 'string', enum: ['xml', 'cdr', 'pdf'] } },
      },
      response: { 200: respuesta('Archivo.'), 404: respuesta('No disponible.') },
    },
  }, async (req, reply) => {
    try {
      const { id, tipo } = z.object({ id: z.string(), tipo: z.enum(['xml', 'cdr', 'pdf']) }).parse(req.params);
      const row = await obtenerDocumento(id);
      if (!row) return reply.code(404).send({ code: 404, message: 'Documento no encontrado' });
      const path = { xml: row.xml_path, cdr: row.cdr_path, pdf: row.pdf_path }[tipo];
      if (!path) return reply.code(404).send({ code: 404, message: `El documento no tiene ${tipo}` });
      const tipos = { xml: 'text/xml; charset=utf-8', cdr: 'application/zip', pdf: 'application/pdf' } as const;
      return reply
        .type(tipos[tipo])
        .header('content-disposition', `inline; filename="${row.nombre_archivo}.${tipo === 'cdr' ? 'zip' : tipo}"`)
        .send(await getStorage().get(path));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/admin/documents/:id/retry', {
    schema: {
      tags: ['backoffice'],
      summary: 'Reintentar el envío de un comprobante',
      description:
        'Reenvía a SUNAT un comprobante en estado EXCEPCION o RECHAZADO reutilizando su payload y su correlativo ' +
        '(no consume uno nuevo). Con `async=true` lo encola en lugar de esperar la respuesta.',
      security: seguridad,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { async: { type: 'boolean', default: false, description: 'Encolar en lugar de enviar en el momento.' } },
      },
      response: {
        200: respuesta('Reintento ejecutado.'),
        202: respuesta('Reintento encolado.'),
        400: respuesta('El tipo de comprobante no admite reintento automático.'),
        404: respuesta('El comprobante o su empresa no existen.'),
        409: respuesta('El comprobante ya fue aceptado: no se reintenta.'),
        501: respuesta('La cola no está habilitada.'),
      },
    },
  }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { async: asincrono } = z.object({ async: z.coerce.boolean().default(false) }).parse(req.query);

      const row = await obtenerDocumento(id);
      if (!row) return reply.code(404).send({ code: 404, message: 'Documento no encontrado' });
      if (row.sunat_state.startsWith('ACEPTADO')) {
        return reply.code(409).send({ code: 409, message: 'El comprobante ya fue aceptado por SUNAT' });
      }
      const schema = REINTENTABLES[row.tipo_comprobante as keyof typeof REINTENTABLES];
      if (!schema) {
        return reply.code(400).send({
          code: 400,
          message: `El reintento automático no está disponible para el tipo ${row.tipo_comprobante}`,
        });
      }
      const tenant = await findTenant(row.tenant_id);
      if (!tenant) return reply.code(404).send({ code: 404, message: 'La empresa emisora ya no existe' });

      const payload = schema.parse(row.payload);
      const esRetPer = row.tipo_comprobante === '20' || row.tipo_comprobante === '40';

      if (asincrono) {
        if (!redisEnabled()) {
          return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado' });
        }
        const job = esRetPer
          ? await getQueue().add('retper', {
              type: 'retper',
              tipo: row.tipo_comprobante as '20' | '40',
              tenantId: tenant.tenant_id,
              payload: payload as never,
            })
          : await getQueue().add('venta', {
              type: 'venta',
              tenantId: tenant.tenant_id,
              documentId: row.id,
              payload: payload as never,
            });
        return reply.code(202).send({ jobId: job.id, state: 'EN_COLA_SUNAT' });
      }

      const secrets = await loadSecrets(tenant);
      const result = esRetPer
        ? await emitirRetPer(tenant, secrets, row.tipo_comprobante as '20' | '40', payload as never, { documentId: row.id })
        : await emitirVenta(tenant, secrets, payload as never, { documentId: row.id });
      return reply.send({
        documentId: result.documentId,
        state: result.state,
        code: result.cdr?.code,
        description: result.cdr?.description ?? result.error,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/admin/queue', {
    schema: {
      tags: ['backoffice'],
      summary: 'Estado de la cola de emisión',
      description: 'Conteos de BullMQ y los últimos trabajos fallidos con su motivo.',
      security: seguridad,
      response: { 200: respuesta('Estado de la cola.') },
    },
  }, async (_req, reply) => {
    if (!redisEnabled()) return reply.send({ habilitada: false });
    try {
      const queue = getQueue();
      const [counts, failed] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
        queue.getFailed(0, 19),
      ]);
      return reply.send({
        habilitada: true,
        counts,
        failed: failed.map((job) => ({
          id: job.id,
          name: job.name,
          intentos: job.attemptsMade,
          motivo: job.failedReason,
          tenant_id: (job.data as { tenantId?: string }).tenantId,
          timestamp: job.timestamp,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/admin/queue/jobs/:jobId/retry', {
    schema: {
      tags: ['backoffice'],
      summary: 'Reintentar un trabajo fallido de la cola',
      security: seguridad,
      params: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
      response: {
        200: respuesta('Trabajo reencolado.'),
        404: respuesta('El trabajo no existe.'),
        501: respuesta('La cola no está habilitada.'),
      },
    },
  }, async (req, reply) => {
    try {
      if (!redisEnabled()) return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado' });
      const { jobId } = req.params as { jobId: string };
      const job = await getQueue().getJob(jobId);
      if (!job) return reply.code(404).send({ code: 404, message: 'Trabajo no encontrado' });
      await job.retry();
      return reply.send({ jobId, retried: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

/** Sirve la interfaz web del backoffice en /admin. */
export async function backofficeUi(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidatos = [
    join(here, 'backoffice.html'),
    join(here, '..', '..', '..', 'src', 'http', 'routes', 'backoffice.html'),
  ];

  app.get('/admin', { schema: { hide: true } }, async (_req, reply) => {
    for (const path of candidatos) {
      try {
        return reply.type('text/html; charset=utf-8').send(await readFile(path, 'utf8'));
      } catch {
        continue;
      }
    }
    return reply.code(500).send({ code: 500, message: 'No se encontró la interfaz del backoffice' });
  });
}
