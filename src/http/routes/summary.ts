import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { summarySchema, voidedSchema } from '../../domain/schemas.ts';
import { buildSummaryXml, buildVoidedXml } from '../../ubl/summary.ts';
import { signUbl } from '../../ubl/sign.ts';
import { consultarTicket, emitirBaja, emitirResumen } from '../../services/emitter.ts';
import { companyOf } from '../../repositories/tenants.ts';
import { nombreBaja, nombreResumen } from '../../services/naming.ts';
import { getQueue, redisEnabled } from '../../queue/index.ts';
import { tenantCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import { EJEMPLO_BAJA, EJEMPLO_RESUMEN } from '../examples.ts';

type Kind = 'summary' | 'voided';

/**
 * Rutas de Resumen Diario de Boletas (`/summary/*`) y Comunicación de Baja
 * (`/voided/*`). Ambos flujos son asíncronos en SUNAT: devuelven un ticket
 * que luego se consulta en `/status`.
 */
export function summaryRoutes(kind: Kind) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', app.requireTenant);
    const schema = kind === 'summary' ? summarySchema : voidedSchema;
    const tag = kind === 'summary' ? 'resumen' : 'baja';
    const nombre = kind === 'summary' ? 'un resumen diario de boletas' : 'una comunicación de baja';
    const seguridad = [{ bearerAuth: [] }];
    const cuerpo = {
      ...jsonSchema(schema),
      example: kind === 'summary' ? EJEMPLO_RESUMEN : EJEMPLO_BAJA,
    };

    app.post('/send', {
      schema: {
        tags: [tag],
        summary: `Enviar ${nombre}`,
        description:
          'SUNAT procesa este documento de forma asíncrona: la respuesta trae un `ticket` ' +
          'que debe consultarse en `/status`. El resultado tarda entre segundos y minutos.',
        security: seguridad,
        body: cuerpo,
        response: {
          200: respuesta('Documento enviado. Devuelve el `ticket` de SUNAT.'),
          400: respuesta('Payload inválido.'),
          422: respuesta('SUNAT rechazó el documento.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const s = await secrets();
        const result = kind === 'summary'
          ? await emitirResumen(tenant, s, summarySchema.parse(req.body))
          : await emitirBaja(tenant, s, voidedSchema.parse(req.body));
        return reply.send({
          summaryId: result.summaryId,
          xml: result.xml,
          hash: result.hash,
          sunatResponse: result.ticket
            ? { success: true, ticket: result.ticket }
            : { success: false, error: { message: result.error } },
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post('/enqueue', {
      schema: {
        tags: [tag],
        summary: `Encolar ${nombre}`,
        description: 'Encola el documento; el worker lo envía y consulta el ticket automáticamente.',
        security: seguridad,
        body: cuerpo,
        response: { 202: respuesta('Documento encolado.'), 501: respuesta('La cola no está habilitada.') },
      },
    }, async (req, reply) => {
      try {
        if (!redisEnabled()) {
          return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado: use /send' });
        }
        const { tenant } = tenantCtx(req);
        const payload = schema.parse(req.body);
        const job = kind === 'summary'
          ? await getQueue().add('resumen', { type: 'resumen', tenantId: tenant.tenant_id, payload: payload as never })
          : await getQueue().add('baja', { type: 'baja', tenantId: tenant.tenant_id, payload: payload as never });
        return reply.code(202).send({ jobId: job.id, state: 'EN_COLA_SUNAT' });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post('/xml', {
      schema: {
        tags: [tag],
        summary: `Generar el XML de ${nombre}`,
        description: 'Devuelve el XML firmado sin enviarlo a SUNAT.',
        security: seguridad,
        body: cuerpo,
        produces: ['text/xml'],
        response: { 200: respuesta('XML firmado.') },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const company = companyOf(tenant);
        let xml: string;
        if (kind === 'summary') {
          const input = summarySchema.parse(req.body);
          const { xmlId } = nombreResumen(tenant.ruc, input.fecResumen ?? input.fecGeneracion, input.correlativo);
          xml = buildSummaryXml({ ...input, company: input.company ?? company, xmlId });
        } else {
          const input = voidedSchema.parse(req.body);
          const { xmlId } = nombreBaja(tenant.ruc, input.fecComunicacion ?? input.fecGeneracion, input.correlativo);
          xml = buildVoidedXml({ ...input, company: input.company ?? company, xmlId });
        }
        const s = await secrets();
        const signed = signUbl(xml, s.certificate.privateKeyPem, s.certificate.certificatePem);
        return reply.type('text/xml; charset=utf-8').send(signed.xml);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.get('/status', {
      schema: {
        tags: [tag],
        summary: 'Consultar el ticket',
        description: 'Devuelve la CDR asociada al ticket. Si `procesando` es `true`, SUNAT aún no termina.',
        security: seguridad,
        querystring: {
          type: 'object',
          required: ['ticket'],
          properties: { ticket: { type: 'string', description: 'Ticket devuelto por /send.', example: '1785416448507' } },
        },
        response: {
          200: respuesta('Estado del ticket.'),
          503: respuesta('SUNAT no está disponible.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const { ticket } = z.object({ ticket: z.string().min(1) }).parse(req.query);
        return reply.send(await consultarTicket(tenant, await secrets(), ticket));
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}
