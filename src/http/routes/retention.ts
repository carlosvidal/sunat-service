import type { FastifyInstance } from 'fastify';
import { perceptionSchema, retentionSchema } from '../../domain/schemas.ts';
import { emitirRetPer, prepararRetPer, xmlRetPer, type TipoRetPer } from '../../services/emitter.ts';
import { normalizar, type PerceptionDoc, type RetentionDoc } from '../../ubl/retention.ts';
import { renderRetPerPdf } from '../../pdf/retention-pdf.ts';
import { signUbl } from '../../ubl/sign.ts';
import { siguienteCorrelativo } from '../../repositories/documents.ts';
import { getQueue, redisEnabled } from '../../queue/index.ts';
import { tenantCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import { EJEMPLO_PERCEPCION, EJEMPLO_RETENCION } from '../examples.ts';

const META = {
  '20': { tag: 'retencion', nombre: 'un comprobante de retención', schema: retentionSchema, ejemplo: EJEMPLO_RETENCION },
  '40': { tag: 'percepcion', nombre: 'un comprobante de percepción', schema: perceptionSchema, ejemplo: EJEMPLO_PERCEPCION },
} as const;

/**
 * Retención (20) y Percepción (40). Se transmiten por el web service de
 * "otros comprobantes" de SUNAT, distinto al de facturas y boletas.
 */
export function retPerRoutes(tipo: TipoRetPer) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', app.requireTenant);
    const meta = META[tipo];
    const schema = meta.schema;
    const seguridad = [{ bearerAuth: [] }];
    const cuerpo = { ...jsonSchema(schema), example: meta.ejemplo };

    const correlativoPreview = async (tenantId: string, serie: string, correlativo?: string) =>
      (correlativo ? Number(correlativo) : siguienteCorrelativo(tenantId, tipo, serie));

    app.post('/send', {
      schema: {
        tags: [meta.tag],
        summary: `Emitir ${meta.nombre}`,
        description:
          'Genera el XML, lo firma y lo envía al servicio de otros comprobantes de SUNAT. ' +
          'La respuesta incluye la CDR. Los importes retenidos/percibidos siempre van en soles.',
        security: seguridad,
        body: cuerpo,
        response: {
          200: respuesta('Comprobante procesado.'),
          400: respuesta('Payload inválido.'),
          409: respuesta('La serie y correlativo ya fueron registrados.'),
          422: respuesta('SUNAT rechazó el comprobante.'),
          503: respuesta('SUNAT no está disponible.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const input = schema.parse(req.body);
        const result = await emitirRetPer(tenant, await secrets(), tipo, input);
        return reply.send({
          documentId: result.documentId,
          xml: result.xml,
          hash: result.hash,
          state: result.state,
          sunatResponse: result.cdr
            ? {
                success: result.cdr.accepted,
                cdrResponse: {
                  id: result.cdr.id,
                  code: result.cdr.code,
                  description: result.cdr.description,
                  notes: result.cdr.notes,
                  accepted: result.cdr.accepted,
                },
              }
            : { success: false, error: { message: result.error ?? 'Sin respuesta de SUNAT' } },
          files: result.paths,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post('/enqueue', {
      schema: {
        tags: [meta.tag],
        summary: `Encolar ${meta.nombre}`,
        security: seguridad,
        body: cuerpo,
        response: { 202: respuesta('Comprobante encolado.'), 501: respuesta('La cola no está habilitada.') },
      },
    }, async (req, reply) => {
      try {
        if (!redisEnabled()) {
          return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado: use /send' });
        }
        const { tenant } = tenantCtx(req);
        const payload = schema.parse(req.body);
        const job = await getQueue().add('retper', {
          type: 'retper', tipo, tenantId: tenant.tenant_id, payload: payload as never,
        });
        return reply.code(202).send({ jobId: job.id, state: 'EN_COLA_SUNAT' });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post('/xml', {
      schema: {
        tags: [meta.tag],
        summary: `Generar el XML de ${meta.nombre}`,
        description: 'Devuelve el XML firmado sin enviarlo a SUNAT ni consumir correlativo.',
        security: seguridad,
        body: cuerpo,
        produces: ['text/xml'],
        response: { 200: respuesta('XML firmado.') },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const input = schema.parse(req.body);
        const n = await correlativoPreview(tenant.tenant_id, input.serie, input.correlativo);
        const doc = prepararRetPer(tenant, input, n) as RetentionDoc | PerceptionDoc;
        const s = await secrets();
        const signed = signUbl(xmlRetPer(tipo, doc), s.certificate.privateKeyPem, s.certificate.certificatePem);
        return reply.type('text/xml; charset=utf-8').send(signed.xml);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post('/pdf', {
      schema: {
        tags: [meta.tag],
        summary: `Generar el PDF de ${meta.nombre}`,
        description: 'Representación impresa con el detalle de los documentos afectados y el código QR.',
        security: seguridad,
        body: cuerpo,
        produces: ['application/pdf'],
        response: { 200: respuesta('PDF del comprobante.') },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const input = schema.parse(req.body);
        const n = await correlativoPreview(tenant.tenant_id, input.serie, input.correlativo);
        const doc = prepararRetPer(tenant, input, n) as RetentionDoc | PerceptionDoc;
        const s = await secrets();
        const signed = signUbl(xmlRetPer(tipo, doc), s.certificate.privateKeyPem, s.certificate.certificatePem);
        const pdf = await renderRetPerPdf(tipo, normalizar(tipo, doc), signed.digestValue);
        return reply
          .type('application/pdf')
          .header('content-disposition', `inline; filename="${tenant.ruc}-${tipo}-${doc.serie}-${doc.correlativo}.pdf"`)
          .send(pdf);
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}
