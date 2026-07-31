import type { FastifyInstance } from 'fastify';
import { invoiceSchema, noteSchema } from '../../domain/schemas.ts';
import { emitirVenta, firmarVenta, prepararVenta, previsualizar } from '../../services/emitter.ts';
import { renderSalePdf } from '../../pdf/sale-pdf.ts';
import { consultarCdr } from '../../services/emitter.ts';
import { getQueue, redisEnabled } from '../../queue/index.ts';
import { tenantCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { z } from 'zod';
import { buscarDocumento, siguienteCorrelativo } from '../../repositories/documents.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import {
  EJEMPLO_BOLETA, EJEMPLO_FACTURA, EJEMPLO_FACTURA_CREDITO, EJEMPLO_FACTURA_DETRACCION,
  EJEMPLO_FACTURA_EXPORTACION, EJEMPLO_NOTA_CREDITO, EJEMPLO_NOTA_DEBITO,
} from '../examples.ts';

type Kind = 'invoice' | 'note';

const schemas = {
  invoice: invoiceSchema,
  note: noteSchema,
} as const;

const META = {
  invoice: {
    tag: 'factura',
    nombre: 'factura o boleta',
    ejemplos: [
      EJEMPLO_FACTURA, EJEMPLO_BOLETA, EJEMPLO_FACTURA_DETRACCION,
      EJEMPLO_FACTURA_CREDITO, EJEMPLO_FACTURA_EXPORTACION,
    ],
  },
  note: {
    tag: 'nota',
    nombre: 'nota de crédito o débito',
    ejemplos: [EJEMPLO_NOTA_CREDITO, EJEMPLO_NOTA_DEBITO],
  },
} as const;

/**
 * Rutas de emisión de Facturas/Boletas (`/invoice/*`) y Notas (`/note/*`).
 * La forma de los payloads sigue el formato de Greenter.
 */
export function saleRoutes(kind: Kind) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', app.requireTenant);
    const schema = schemas[kind];
    const meta = META[kind];
    const seguridad = [{ bearerAuth: [] }];
    const cuerpo = {
      ...jsonSchema(schema, 'Comprobante en formato Greenter. Los importes que se omitan se calculan a partir de los ítems. ' +
        'Vea más casos (detracción, crédito, exportación, ICBPER) en `GET /examples`.'),
      example: meta.ejemplos[0],
    };

    /** Emisión síncrona: firma, envía a SUNAT y devuelve la CDR. */
    app.post('/send', {
      schema: {
        tags: [meta.tag],
        summary: `Emitir una ${meta.nombre}`,
        description:
          'Reserva el correlativo, genera el XML UBL 2.1, lo firma, lo envía a SUNAT y devuelve la CDR. ' +
          'Si se omite `correlativo` se toma el siguiente de la serie de forma atómica. ' +
          'La respuesta incluye el XML firmado y las rutas de los artefactos almacenados (XML, CDR y PDF).',
        security: seguridad,
        body: cuerpo,
        response: {
          200: respuesta('Comprobante procesado. Revise `state` y `sunatResponse.cdrResponse.code`.'),
          400: respuesta('Payload inválido o totales incoherentes.'),
          409: respuesta('La serie y correlativo ya fueron registrados.'),
          422: respuesta('SUNAT rechazó el comprobante.'),
          503: respuesta('SUNAT no está disponible: reintente más tarde.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const input = schema.parse(req.body);
        const result = await emitirVenta(tenant, await secrets(), input);
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
            : { success: false, error: { code: '0', message: result.error ?? 'Sin respuesta de SUNAT' } },
          files: result.paths,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    /** Emisión asíncrona: encola el comprobante y responde de inmediato. */
    app.post('/enqueue', {
      schema: {
        tags: [meta.tag],
        summary: `Encolar una ${meta.nombre}`,
        description:
          'Encola el comprobante y responde de inmediato, sin bloquear el flujo de venta. ' +
          'El worker reintenta ante caídas de SUNAT (1, 5 y 15 minutos) y notifica el resultado por webhook. ' +
          'Requiere `REDIS_URL` configurado.',
        security: seguridad,
        body: cuerpo,
        response: {
          202: respuesta('Comprobante encolado. Devuelve `jobId`.'),
          501: respuesta('La cola no está habilitada en este despliegue.'),
        },
      },
    }, async (req, reply) => {
      try {
        if (!redisEnabled()) {
          return reply.code(501).send({ code: 501, message: 'REDIS_URL no configurado: use /send' });
        }
        const { tenant } = tenantCtx(req);
        const input = schema.parse(req.body);
        const job = await getQueue().add('venta', { type: 'venta', tenantId: tenant.tenant_id, payload: input });
        return reply.code(202).send({ jobId: job.id, state: 'EN_COLA_SUNAT' });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    /** Devuelve el XML firmado sin enviarlo a SUNAT. */
    app.post('/xml', {
      schema: {
        tags: [meta.tag],
        summary: `Generar el XML de una ${meta.nombre}`,
        description: 'Devuelve el XML UBL 2.1 firmado sin enviarlo a SUNAT ni consumir correlativo. Útil para depurar.',
        security: seguridad,
        body: cuerpo,
        produces: ['text/xml'],
        response: { 200: respuesta('XML firmado.') },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const input = schema.parse(req.body);
        const doc = prepararVenta(tenant, input, await correlativoPreview(tenant.tenant_id, input));
        const artifacts = await firmarVenta(tenant, await secrets(), doc);
        return reply.type('text/xml; charset=utf-8').send(artifacts.xml);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    /** Devuelve la representación impresa en PDF. */
    app.post('/pdf', {
      schema: {
        tags: [meta.tag],
        summary: `Generar el PDF de una ${meta.nombre}`,
        description: 'Representación impresa con el código QR normativo. No envía nada a SUNAT.',
        security: seguridad,
        body: cuerpo,
        querystring: {
          type: 'object',
          properties: {
            formato: { type: 'string', enum: ['a4', 'ticket'], default: 'a4', description: 'A4 o ticket de 80 mm.' },
          },
        },
        produces: ['application/pdf'],
        response: { 200: respuesta('PDF del comprobante.') },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const query = z.object({ formato: z.enum(['a4', 'ticket']).default('a4') }).parse(req.query);
        const input = schema.parse(req.body);
        const doc = prepararVenta(tenant, input, await correlativoPreview(tenant.tenant_id, input));
        const artifacts = await firmarVenta(tenant, await secrets(), doc);
        const pdf = await renderSalePdf(doc, { formato: query.formato, digestValue: artifacts.digestValue });
        return reply
          .type('application/pdf')
          .header('content-disposition', `inline; filename="${artifacts.fileName}.pdf"`)
          .send(pdf);
      } catch (err) {
        return sendError(reply, err);
      }
    });


    /** Previsualiza el comprobante: calcula totales sin tocar SUNAT ni la base. */
    app.post('/preview', {
      schema: {
        tags: [meta.tag],
        summary: `Previsualizar ${meta.nombre}`,
        description:
          'Calcula totales, correlativo sugerido y leyendas **sin emitir**: no consume correlativo, ' +
          'no escribe en la base y no contacta a SUNAT. Devuelve además las advertencias detectadas ' +
          'y una huella del comprobante (`huella`) que `/send` puede exigir para confirmar que se ' +
          'emite exactamente lo previsualizado. Pensado para flujos asistidos por agentes de IA.',
        security: seguridad,
        body: cuerpo,
        response: {
          200: respuesta('Previsualización del comprobante.'),
          400: respuesta('Payload inválido.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant } = tenantCtx(req);
        const input = schema.parse(req.body);
        const correlativo = await correlativoPreview(tenant.tenant_id, input);
        const doc = prepararVenta(tenant, input, correlativo);
        return reply.send(previsualizar(doc));
      } catch (err) {
        return sendError(reply, err);
      }
    });

    /** Consulta el estado/CDR de un comprobante en SUNAT. */
    app.get('/status', {
      schema: {
        tags: [meta.tag],
        summary: 'Consultar el estado de un comprobante',
        description: 'Devuelve la CDR consultada en SUNAT y el estado registrado localmente.',
        security: seguridad,
        querystring: {
          type: 'object',
          required: ['tipo', 'serie', 'numero'],
          properties: {
            tipo: { type: 'string', description: 'Tipo de comprobante (01, 03, 07, 08).', example: '01' },
            serie: { type: 'string', description: 'Serie del comprobante.', example: 'F001' },
            numero: { type: 'string', description: 'Número correlativo.', example: '1' },
          },
        },
        response: {
          200: respuesta('Estado del comprobante.'),
          503: respuesta('El servicio de consulta de SUNAT no está disponible.'),
        },
      },
    }, async (req, reply) => {
      try {
        const { tenant, secrets } = tenantCtx(req);
        const q = z.object({
          tipo: z.string(),
          serie: z.string(),
          numero: z.coerce.string(),
        }).parse(req.query);
        const local = await buscarDocumento(tenant.tenant_id, q.tipo, q.serie, Number(q.numero));
        const remoto = await consultarCdr(tenant, await secrets(), q.tipo, q.serie, q.numero);
        return reply.send({
          ...remoto,
          local: local
            ? {
                documentId: local.id,
                state: local.sunat_state,
                code: local.sunat_code,
                description: local.sunat_description,
                files: { xml: local.xml_path, cdr: local.cdr_path, pdf: local.pdf_path },
              }
            : null,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}

/**
 * Correlativo a usar en las previsualizaciones (`/xml`, `/pdf`): el enviado por
 * el cliente o, si se omite, el siguiente de la serie sin consumirlo.
 */
async function correlativoPreview(
  tenantId: string,
  input: { tipoDoc: string; serie: string; correlativo?: string },
): Promise<number> {
  if (input.correlativo) return Number(input.correlativo);
  return siguienteCorrelativo(tenantId, input.tipoDoc, input.serie);
}
