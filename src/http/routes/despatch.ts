import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { despatchSchema } from '../../domain/schemas.ts';
import { buildDespatchXml } from '../../ubl/despatch.ts';
import { signUbl } from '../../ubl/sign.ts';
import { consultarTicketGuia, emitirGuia, prepararGuia } from '../../services/emitter.ts';
import { siguienteCorrelativo } from '../../repositories/documents.ts';
import { getQueue, redisEnabled } from '../../queue/index.ts';
import { tenantCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import { EJEMPLO_GUIA } from '../examples.ts';

/**
 * Guía de Remisión Electrónica (GRE 2022). Requiere que la empresa tenga
 * configurados client_id y client_secret de la API SUNAT.
 */
export async function despatchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireTenant);
  const seguridad = [{ bearerAuth: [] }];
  const cuerpo = { ...jsonSchema(despatchSchema), example: EJEMPLO_GUIA };

  app.post('/send', {
    schema: {
      tags: ['guia'],
      summary: 'Enviar una guía de remisión',
      description:
        'Emite la GRE por la API REST de SUNAT (no por SOAP). Requiere que la empresa tenga ' +
        '`client_id` y `client_secret` generados en el portal SOL. Devuelve un `ticket` a consultar en /status.',
      security: seguridad,
      body: cuerpo,
      response: {
        200: respuesta('Guía enviada. Devuelve el `ticket`.'),
        400: respuesta('Payload inválido o faltan las credenciales de la API SUNAT.'),
      },
    },
  }, async (req, reply) => {
    try {
      const { tenant, secrets } = tenantCtx(req);
      const input = despatchSchema.parse(req.body);
      const result = await emitirGuia(tenant, await secrets(), input);
      return reply.send({
        documentId: result.documentId,
        xml: result.xml,
        hash: result.hash,
        state: result.state,
        sunatResponse: result.ticket
          ? { success: true, ticket: result.ticket }
          : { success: false, error: { message: result.error } },
        files: result.paths,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/enqueue', {
    schema: {
      tags: ['guia'],
      summary: 'Encolar una guía de remisión',
      security: seguridad,
      body: cuerpo,
      response: { 202: respuesta('Guía encolada.'), 501: respuesta('La cola no está habilitada.') },
    },
  }, async (req, reply) => {
    try {
      if (!redisEnabled()) {
        return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado: use /send' });
      }
      const { tenant } = tenantCtx(req);
      const payload = despatchSchema.parse(req.body);
      const job = await getQueue().add('guia', { type: 'guia', tenantId: tenant.tenant_id, payload });
      return reply.code(202).send({ jobId: job.id, state: 'EN_COLA_SUNAT' });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/xml', {
    schema: {
      tags: ['guia'],
      summary: 'Generar el XML de una guía de remisión',
      description: 'Devuelve el DespatchAdvice UBL 2.1 firmado, sin enviarlo a SUNAT.',
      security: seguridad,
      body: cuerpo,
      produces: ['text/xml'],
      response: { 200: respuesta('XML firmado.') },
    },
  }, async (req, reply) => {
    try {
      const { tenant, secrets } = tenantCtx(req);
      const input = despatchSchema.parse(req.body);
      const correlativo = input.correlativo
        ? Number(input.correlativo)
        : await siguienteCorrelativo(tenant.tenant_id, input.tipoDoc, input.serie);
      const doc = prepararGuia(tenant, input, correlativo);
      const s = await secrets();
      const signed = signUbl(buildDespatchXml(doc), s.certificate.privateKeyPem, s.certificate.certificatePem);
      return reply.type('text/xml; charset=utf-8').send(signed.xml);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/status', {
    schema: {
      tags: ['guia'],
      summary: 'Consultar el ticket de una guía',
      security: seguridad,
      querystring: {
        type: 'object',
        required: ['ticket'],
        properties: { ticket: { type: 'string', description: 'Ticket devuelto por /send.' } },
      },
      response: { 200: respuesta('Estado de la guía.') },
    },
  }, async (req, reply) => {
    try {
      const { tenant, secrets } = tenantCtx(req);
      const { ticket } = z.object({ ticket: z.string().min(1) }).parse(req.query);
      return reply.send(await consultarTicketGuia(tenant, await secrets(), ticket));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
