import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addressSchema } from '../../domain/schemas.ts';
import { deleteTenant, findTenant, listTenantsByOperator, toPublic, upsertTenant } from '../../repositories/tenants.ts';
import { tenantBelongsToOperator } from '../../repositories/operators.ts';
import { generateSelfSignedPfx, loadCertificate } from '../../security/certificate.ts';
import { issueTenantToken, operatorCtx } from '../auth.ts';
import { sendError } from '../errors.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import { EJEMPLO_EMPRESA } from '../examples.ts';

const companyBody = z.object({
  tenant_id: z.string().min(1).max(64),
  ruc: z.string().regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos'),
  razon_social: z.string().min(1),
  nombre_comercial: z.string().optional(),
  domicilio_fiscal: addressSchema,
  sol_user: z.string().min(1),
  sol_pass: z.string().min(1),
  /** Certificado .pfx/.p12 (o PEM) codificado en base64. */
  certificado: z.string().min(1),
  cert_password: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  environment: z.enum(['beta', 'produccion']).default('beta'),
  webhook_url: z.string().refine((v) => /^https?:\/\//.test(v), 'La URL del webhook debe iniciar con http(s)://').optional(),
  webhook_secret: z.string().optional(),
});

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  // Administración de empresas: requiere una API key de operador válida.
  // Cada operador sólo ve y administra las empresas que le pertenecen.
  app.addHook('onRequest', app.requireOperator);

  const seguridad = [{ operatorKey: [] }];
  const paramsTenant = {
    type: 'object',
    required: ['tenantId'],
    properties: { tenantId: { type: 'string', description: 'Identificador de la empresa.' } },
  };

  app.post('/companies', {
    schema: {
      tags: ['empresa'],
      summary: 'Registrar o actualizar una empresa emisora',
      description:
        'Alta idempotente por `tenant_id`. Valida el certificado antes de guardarlo, cifra la clave SOL y ' +
        'la del certificado con AES-256-GCM, asocia la empresa al operador autenticado y devuelve el ' +
        'token con el que la empresa emitirá. El certificado se envía en base64 (`.pfx`, `.p12` o PEM).',
      security: seguridad,
      body: { ...jsonSchema(companyBody), example: EJEMPLO_EMPRESA },
      response: {
        200: respuesta('Empresa registrada. Incluye `token`.'),
        400: respuesta('Datos inválidos o certificado ilegible.'),
        401: respuesta('API key de operador inválida.'),
        409: respuesta('La empresa pertenece a otro operador.'),
      },
    },
  }, async (req, reply) => {
    try {
      const body = companyBody.parse(req.body);
      const { operator } = operatorCtx(req);
      // Si la empresa ya existe, debe pertenecer a este operador; si no, se
      // rechaza con 409 para evitar robo de empresas vía tenant_id ajeno.
      const existing = await findTenant(body.tenant_id);
      if (existing && existing.operator_id !== operator.operator_id) {
        return reply.code(409).send({
          code: 409,
          message: 'La empresa ya existe y pertenece a otro operador',
        });
      }
      const tenant = await upsertTenant({
        tenantId: body.tenant_id,
        ruc: body.ruc,
        razonSocial: body.razon_social,
        nombreComercial: body.nombre_comercial,
        domicilioFiscal: body.domicilio_fiscal,
        solUser: body.sol_user,
        solPass: body.sol_pass,
        certificado: body.certificado,
        certPassword: body.cert_password,
        clientId: body.client_id,
        clientSecret: body.client_secret,
        ambiente: body.environment,
        webhookUrl: body.webhook_url,
        webhookSecret: body.webhook_secret,
        operatorId: operator.operator_id,
      });
      return reply.send({ ...toPublic(tenant), token: issueTenantToken(app, tenant) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/companies', {
    schema: {
      tags: ['empresa'],
      summary: 'Listar empresas del operador',
      description: 'Sólo las empresas que pertenecen al operador autenticado. Nunca devuelve secretos ni el certificado.',
      security: seguridad,
      response: { 200: respuesta('Listado de empresas.') },
    },
  }, async (req, reply) => {
    const { operator } = operatorCtx(req);
    const tenants = await listTenantsByOperator(operator.operator_id);
    return reply.send(tenants.map(toPublic));
  });

  app.get('/companies/:tenantId', {
    schema: {
      tags: ['empresa'],
      summary: 'Obtener una empresa',
      description: 'Incluye la vigencia del certificado digital. Sólo si pertenece al operador.',
      security: seguridad,
      params: paramsTenant,
      response: { 200: respuesta('Datos de la empresa.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const { operator } = operatorCtx(req);
    const tenant = await findTenant(tenantId);
    if (!tenant || tenant.operator_id !== operator.operator_id) {
      return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
    }
    return reply.send(toPublic(tenant));
  });

  /** Reemite el token de emisión de una empresa. */
  app.post('/companies/:tenantId/token', {
    schema: {
      tags: ['empresa'],
      summary: 'Reemitir el token de emisión',
      description: 'Genera un nuevo token para la empresa. Los tokens anteriores siguen siendo válidos.',
      security: seguridad,
      params: paramsTenant,
      response: { 200: respuesta('Nuevo token.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const { operator } = operatorCtx(req);
    if (!(await tenantBelongsToOperator(tenantId, operator.operator_id))) {
      return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
    }
    const tenant = await findTenant(tenantId);
    if (!tenant) return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
    return reply.send({ token: issueTenantToken(app, tenant) });
  });

  app.delete('/companies/:tenantId', {
    schema: {
      tags: ['empresa'],
      summary: 'Eliminar una empresa',
      description: 'Elimina la empresa y, en cascada, sus series y comprobantes registrados.',
      security: seguridad,
      params: paramsTenant,
      response: { 200: respuesta('Empresa eliminada.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const { operator } = operatorCtx(req);
    if (!(await tenantBelongsToOperator(tenantId, operator.operator_id))) {
      return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
    }
    const ok = await deleteTenant(tenantId);
    if (!ok) return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
    return reply.send({ deleted: true });
  });

  /** Inspecciona un certificado sin almacenarlo (validación previa). */
  app.post('/companies/certificate/inspect', {
    schema: {
      tags: ['empresa'],
      summary: 'Inspeccionar un certificado',
      description: 'Verifica que el certificado abra con la contraseña indicada y muestra titular, RUC y vigencia. No lo almacena.',
      security: seguridad,
      body: {
        type: 'object',
        required: ['cert'],
        properties: {
          cert: { type: 'string', description: 'Certificado .pfx/.p12 o PEM en base64.' },
          cert_pass: { type: 'string', description: 'Contraseña del certificado.' },
        },
      },
      response: { 200: respuesta('Datos del certificado.'), 400: respuesta('Certificado ilegible o contraseña incorrecta.') },
    },
  }, async (req, reply) => {
    try {
      const body = z.object({ cert: z.string(), cert_pass: z.string().optional() }).parse(req.body);
      const material = loadCertificate(Buffer.from(body.cert, 'base64'), body.cert_pass);
      return reply.send({
        subject: material.subject,
        issuer: material.issuer,
        serial_number: material.serialNumber,
        ruc: material.ruc,
        valido_desde: material.validFrom,
        valido_hasta: material.validTo,
        vencido: material.validTo.getTime() < Date.now(),
        pem: material.certificatePem,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Genera un certificado autofirmado para pruebas en BETA. */
  app.post('/companies/certificate/free', {
    schema: {
      tags: ['empresa'],
      summary: 'Generar un certificado de prueba',
      description:
        'Genera un certificado autofirmado para el ambiente BETA de SUNAT. ' +
        'No sirve en producción: allí se requiere un certificado emitido por una entidad autorizada.',
      security: seguridad,
      body: {
        type: 'object',
        required: ['ruc', 'password'],
        properties: {
          ruc: { type: 'string', description: 'RUC de 11 dígitos.', example: '20000000001' },
          razon_social: { type: 'string', default: 'EMPRESA DE PRUEBA' },
          password: { type: 'string', description: 'Contraseña con la que se protegerá el .pfx.' },
        },
      },
      response: { 200: respuesta('Certificado en base64.') },
    },
  }, async (req, reply) => {
    try {
      const body = z.object({
        ruc: z.string().regex(/^\d{11}$/),
        razon_social: z.string().default('EMPRESA DE PRUEBA'),
        password: z.string().min(1),
      }).parse(req.body);
      const { pfx, material } = generateSelfSignedPfx(body.ruc, body.razon_social, body.password);
      return reply.send({
        pfx_base64: pfx.toString('base64'),
        subject: material.subject,
        valido_hasta: material.validTo,
        advertencia: 'Certificado autofirmado: sólo válido para el ambiente BETA de SUNAT.',
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
