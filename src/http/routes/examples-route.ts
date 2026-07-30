import type { FastifyInstance } from 'fastify';
import * as ejemplos from '../examples.ts';
import { respuesta } from '../openapi.ts';

/** Catálogo de payloads de ejemplo, para quien integra la API. */
const CATALOGO: Record<string, { titulo: string; payload: unknown }> = {
  factura: { titulo: 'Factura gravada simple', payload: ejemplos.EJEMPLO_FACTURA },
  boleta: { titulo: 'Boleta con ICBPER (bolsa plástica)', payload: ejemplos.EJEMPLO_BOLETA },
  factura_detraccion: { titulo: 'Factura con detracción', payload: ejemplos.EJEMPLO_FACTURA_DETRACCION },
  factura_credito: { titulo: 'Factura al crédito con cuotas', payload: ejemplos.EJEMPLO_FACTURA_CREDITO },
  factura_exportacion: { titulo: 'Factura de exportación', payload: ejemplos.EJEMPLO_FACTURA_EXPORTACION },
  nota_credito: { titulo: 'Nota de crédito que anula una factura', payload: ejemplos.EJEMPLO_NOTA_CREDITO },
  nota_debito: { titulo: 'Nota de débito por intereses', payload: ejemplos.EJEMPLO_NOTA_DEBITO },
  resumen: { titulo: 'Resumen diario de boletas', payload: ejemplos.EJEMPLO_RESUMEN },
  baja: { titulo: 'Comunicación de baja', payload: ejemplos.EJEMPLO_BAJA },
  guia: { titulo: 'Guía de remisión remitente', payload: ejemplos.EJEMPLO_GUIA },
  retencion: { titulo: 'Comprobante de retención (3 %)', payload: ejemplos.EJEMPLO_RETENCION },
  percepcion: { titulo: 'Comprobante de percepción (2 %)', payload: ejemplos.EJEMPLO_PERCEPCION },
  empresa: { titulo: 'Alta de empresa emisora', payload: ejemplos.EJEMPLO_EMPRESA },
};

export async function exampleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/examples', {
    schema: {
      tags: ['ejemplos'],
      summary: 'Catálogo de payloads de ejemplo',
      description: 'Payloads listos para copiar y pegar en cada endpoint. No requiere autenticación.',
      response: { 200: respuesta('Catálogo de ejemplos.') },
    },
  }, async () => CATALOGO);

  app.get('/examples/:nombre', {
    schema: {
      tags: ['ejemplos'],
      summary: 'Obtener un ejemplo',
      params: {
        type: 'object',
        required: ['nombre'],
        properties: { nombre: { type: 'string', enum: Object.keys(CATALOGO) } },
      },
      response: { 200: respuesta('Payload de ejemplo.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { nombre } = req.params as { nombre: string };
    const ejemplo = CATALOGO[nombre];
    if (!ejemplo) return reply.code(404).send({ code: 404, message: 'Ejemplo no encontrado' });
    return reply.send(ejemplo.payload);
  });
}
