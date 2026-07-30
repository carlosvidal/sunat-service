import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listarDocumentos, obtenerDocumento, type SunatState } from '../../repositories/documents.ts';
import { getStorage } from '../../storage/index.ts';
import { tenantCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { respuesta } from '../openapi.ts';

const ESTADOS = [
  'PENDIENTE', 'EN_COLA_SUNAT', 'ACEPTADO', 'ACEPTADO_CON_OBSERVACIONES',
  'RECHAZADO', 'EXCEPCION', 'ANULADO',
] as const;

function toPublic(row: Awaited<ReturnType<typeof obtenerDocumento>>) {
  if (!row) return null;
  return {
    id: row.id,
    tipo_comprobante: row.tipo_comprobante,
    serie: row.serie,
    correlativo: row.correlativo,
    nombre_archivo: row.nombre_archivo,
    fecha_emision: row.fecha_emision,
    moneda: row.moneda,
    monto_total: Number(row.monto_total),
    state: row.sunat_state,
    sunat_code: row.sunat_code,
    sunat_description: row.sunat_description,
    sunat_notes: row.sunat_notes,
    ticket: row.ticket,
    hash: row.digest_value,
    retry_count: row.retry_count,
    last_error: row.last_error,
    files: { xml: row.xml_path, cdr: row.cdr_path, pdf: row.pdf_path },
    created_at: row.created_at,
  };
}

/** Consulta del histórico y descarga de artefactos almacenados. */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireTenant);

  const seguridad = [{ bearerAuth: [] }];

  app.get('/documents', {
    schema: {
      tags: ['documentos'],
      summary: 'Listar comprobantes emitidos',
      description: 'Histórico de la empresa autenticada, del más reciente al más antiguo.',
      security: seguridad,
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: [...ESTADOS], description: 'Filtra por estado.' },
          desde: { type: 'string', description: 'Fecha de emisión mínima (YYYY-MM-DD).' },
          hasta: { type: 'string', description: 'Fecha de emisión máxima (YYYY-MM-DD).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: { 200: respuesta('Listado de comprobantes.') },
    },
  }, async (req, reply) => {
    try {
      const { tenant } = tenantCtx(req);
      const q = z.object({
        state: z.enum(ESTADOS).optional(),
        desde: z.string().optional(),
        hasta: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      }).parse(req.query);
      const rows = await listarDocumentos(tenant.tenant_id, { ...q, state: q.state as SunatState | undefined });
      return reply.send(rows.map(toPublic));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/documents/:id', {
    schema: {
      tags: ['documentos'],
      summary: 'Obtener un comprobante',
      security: seguridad,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'UUID del comprobante.' } },
      },
      response: { 200: respuesta('Detalle del comprobante.'), 404: respuesta('No existe o pertenece a otra empresa.') },
    },
  }, async (req, reply) => {
    const { tenant } = tenantCtx(req);
    const { id } = req.params as { id: string };
    const row = await obtenerDocumento(id);
    if (!row || row.tenant_id !== tenant.tenant_id) {
      return reply.code(404).send({ code: 404, message: 'Documento no encontrado' });
    }
    return reply.send(toPublic(row));
  });

  const artefacto = { xml: 'xml_path', cdr: 'cdr_path', pdf: 'pdf_path' } as const;
  const contentTypes = { xml: 'text/xml; charset=utf-8', cdr: 'application/zip', pdf: 'application/pdf' } as const;

  app.get('/documents/:id/:tipo', {
    schema: {
      tags: ['documentos'],
      summary: 'Descargar el XML, la CDR o el PDF',
      description: 'Devuelve el artefacto almacenado. La CDR se entrega como .zip, tal como la envía SUNAT.',
      security: seguridad,
      params: {
        type: 'object',
        required: ['id', 'tipo'],
        properties: {
          id: { type: 'string', description: 'UUID del comprobante.' },
          tipo: { type: 'string', enum: ['xml', 'cdr', 'pdf'] },
        },
      },
      response: { 200: respuesta('Archivo solicitado.'), 404: respuesta('El comprobante no tiene ese artefacto.') },
    },
  }, async (req, reply) => {
    try {
      const { tenant } = tenantCtx(req);
      const { id, tipo } = z.object({ id: z.string(), tipo: z.enum(['xml', 'cdr', 'pdf']) }).parse(req.params);
      const row = await obtenerDocumento(id);
      if (!row || row.tenant_id !== tenant.tenant_id) {
        return reply.code(404).send({ code: 404, message: 'Documento no encontrado' });
      }
      const path = row[artefacto[tipo]];
      if (!path) return reply.code(404).send({ code: 404, message: `El documento no tiene ${tipo}` });
      const data = await getStorage().get(path);
      const ext = tipo === 'cdr' ? 'zip' : tipo;
      return reply
        .type(contentTypes[tipo])
        .header('content-disposition', `inline; filename="${row.nombre_archivo}.${ext}"`)
        .send(data);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
