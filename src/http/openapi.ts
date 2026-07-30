import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z, type ZodType } from 'zod';

/**
 * Convierte un esquema zod al JSON Schema que consume OpenAPI.
 *
 * Los esquemas se usan SÓLO para documentar: la validación real la sigue
 * haciendo zod dentro de cada handler (ver `noopValidator`), porque acepta
 * coerciones —RUC como número, importes como string— que un JSON Schema
 * estricto rechazaría.
 */
export function jsonSchema(schema: ZodType, description?: string): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete out.$schema;
  if (description) out.description = description;
  return out;
}

/** Respuesta documentada sin `type`, para no activar la serialización de Fastify. */
export function respuesta(description: string): { description: string } {
  return { description };
}

const DESCRIPTION = `
API de emisión electrónica para SUNAT (modalidad **SEE - Del Contribuyente**).

Genera el XML UBL 2.1, lo firma con XMLDSig (RSA-SHA256), lo envía a SUNAT,
procesa la CDR y produce la representación impresa en PDF con código QR.

### Autenticación

| Ámbito | Cabecera | Uso |
| --- | --- | --- |
| Plataforma | \`X-API-Key\` | Alta y administración de empresas, backoffice. |
| Empresa | \`Authorization: Bearer <token>\` | Emisión y consulta de comprobantes. |

El token de empresa se obtiene al crear la empresa (\`POST /companies\`) y no expira.

### Flujo típico

1. \`POST /companies\` — registrar la empresa con su certificado y clave SOL.
2. \`POST /invoice/send\` — emitir. La respuesta trae la CDR de SUNAT.
3. \`GET /documents\` — consultar el histórico y descargar XML, CDR y PDF.

Para no bloquear el flujo de venta use \`/invoice/enqueue\`: el comprobante se
procesa en segundo plano con reintentos (1, 5 y 15 minutos) y el resultado se
notifica por webhook.

### Compatibilidad

La estructura de los comprobantes es compatible con **Greenter / APIsPERU**:
los mismos campos (\`tipoDoc\`, \`serie\`, \`details\`, \`tipAfeIgv\`, \`mtoValorUnitario\`…)
producen el mismo XML.
`.trim();

export const openapiPlugin = fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Facturación Electrónica SUNAT',
        description: DESCRIPTION,
        version: '1.0.0',
        contact: { name: 'MiTienda', email: 'soporte@mitienda.pe' },
      },
      servers: [{ url: '/api/v1', description: 'Base de la API' }],
      tags: [
        { name: 'empresa', description: 'Alta y administración de empresas emisoras (requiere X-API-Key).' },
        { name: 'factura', description: 'Facturas (01) y Boletas de Venta (03).' },
        { name: 'nota', description: 'Notas de Crédito (07) y de Débito (08).' },
        { name: 'resumen', description: 'Resumen Diario de Boletas (RC). Asíncrono: devuelve un ticket.' },
        { name: 'baja', description: 'Comunicación de Baja (RA). Asíncrono: devuelve un ticket.' },
        { name: 'guia', description: 'Guía de Remisión Electrónica (GRE 2022, API REST de SUNAT).' },
        { name: 'retencion', description: 'Comprobante de Retención (20).' },
        { name: 'percepcion', description: 'Comprobante de Percepción (40).' },
        { name: 'documentos', description: 'Histórico de comprobantes y descarga de artefactos.' },
        { name: 'ejemplos', description: 'Payloads de ejemplo listos para copiar (público).' },
        { name: 'backoffice', description: 'Monitoreo y operación (requiere X-API-Key).' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token de la empresa emisora.' },
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header', description: 'Clave maestra de la plataforma.' },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });
});
