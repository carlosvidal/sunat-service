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
| Plataforma (super-admin) | \`X-API-Key\` | Crear operadores, gestionar sus claves, reasignar empresas, backoffice. |
| Operador (PMS/ERP) | \`X-Operator-Key\` | Alta y administración de las **empresas que le pertenecen**. |
| Empresa | \`Authorization: Bearer <token>\` | Emisión y consulta de comprobantes. |

El operador obtiene su API key (\`skop_...\`) al crearla con \`POST /operators/:id/keys\` (super-admin) y la
entrega al sistema externo. La empresa obtiene su token al ser registrada (\`POST /companies\`) y no expira.

Rotación de la clave de un operador: \`POST /operators/:id/keys\` (nueva) → distribuir →
\`DELETE /operators/:id/keys/:old\` (revocar la vieja). Sin downtime ni coordinación con otros operadores.

### Flujo típico

1. \`POST /operators\` (super-admin) — crear el operador y emitirle una API key.
2. \`POST /companies\` (operador) — registrar la empresa con su certificado y clave SOL.
3. \`POST /invoice/send\` (empresa) — emitir. La respuesta trae la CDR de SUNAT.
4. \`GET /documents\` — consultar el histórico y descargar XML, CDR y PDF.

Para no bloquear el flujo de venta use \`/invoice/enqueue\`: el comprobante se
procesa en segundo plano con reintentos (1, 5 y 15 minutos) y el resultado se
notifica por webhook.

### Compatibilidad

La estructura de los comprobantes sigue el formato de
[Greenter](https://greenter.dev): los mismos campos (\`tipoDoc\`, \`serie\`, \`details\`,
\`tipAfeIgv\`, \`mtoValorUnitario\`…) producen el mismo XML.
`.trim();

export const openapiPlugin = fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Facturación Electrónica SUNAT',
        description: DESCRIPTION,
        version: '1.0.0',
        license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      },
      servers: [{ url: '/api/v1', description: 'Base de la API' }],
      tags: [
        { name: 'empresa', description: 'Alta y administración de empresas emisoras (requiere API key de operador).' },
        { name: 'operadores', description: 'Gestión de operadores y sus claves, reasignación de empresas (requiere X-API-Key de super-admin).' },
        { name: 'factura', description: 'Facturas (01) y Boletas de Venta (03).' },
        { name: 'nota', description: 'Notas de Crédito (07) y de Débito (08).' },
        { name: 'resumen', description: 'Resumen Diario de Boletas (RC). Asíncrono: devuelve un ticket.' },
        { name: 'baja', description: 'Comunicación de Baja (RA). Asíncrono: devuelve un ticket.' },
        { name: 'guia', description: 'Guía de Remisión Electrónica (GRE 2022, API REST de SUNAT).' },
        { name: 'retencion', description: 'Comprobante de Retención (20).' },
        { name: 'percepcion', description: 'Comprobante de Percepción (40).' },
        { name: 'documentos', description: 'Histórico de comprobantes y descarga de artefactos.' },
        { name: 'ejemplos', description: 'Payloads de ejemplo listos para copiar (público).' },
        { name: 'backoffice', description: 'Monitoreo y operación (requiere X-API-Key de super-admin).' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token de la empresa emisora.' },
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header', description: 'Clave maestra de la plataforma (super-admin).' },
          operatorKey: { type: 'apiKey', name: 'x-operator-key', in: 'header', description: 'API key de operador (skop_...).' },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });
});
