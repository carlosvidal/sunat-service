import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError } from '../errors.ts';
import { jsonSchema, respuesta } from '../openapi.ts';
import {
  assignOperator,
  createApiKey,
  createOperator,
  deleteOperator,
  findOperator,
  listApiKeys,
  listOperators,
  revokeApiKey,
  setOperatorActive,
} from '../../repositories/operators.ts';
import { findTenant as findTenantRow } from '../../repositories/tenants.ts';

const createOperatorBody = z.object({
  operator_id: z.string().min(1).max(64),
  nombre: z.string().min(1).max(255),
});

const createKeyBody = z.object({
  label: z.string().max(120).optional(),
});

const reassignBody = z.object({
  operator_id: z.string().min(1).max(64),
});

const paramsOperator = {
  type: 'object',
  required: ['operatorId'],
  properties: { operatorId: { type: 'string', description: 'Identificador del operador.' } },
};

const paramsTenant = {
  type: 'object',
  required: ['tenantId'],
  properties: { tenantId: { type: 'string', description: 'Identificador de la empresa.' } },
};

const paramsKey = {
  type: 'object',
  required: ['operatorId', 'keyId'],
  properties: {
    operatorId: { type: 'string', description: 'Identificador del operador.' },
    keyId: { type: 'string', format: 'uuid', description: 'Identificador de la clave.' },
  },
};

export async function operatorRoutes(app: FastifyInstance): Promise<void> {
  // Administración de operadores: requiere la clave maestra de la plataforma.
  app.addHook('onRequest', app.requireMasterKey);
  const seguridad = [{ apiKey: [] }];

  app.post('/operators', {
    schema: {
      tags: ['operadores'],
      summary: 'Crear o actualizar un operador',
      description:
        'Alta idempotente por `operator_id`. Un operador (PMS, ERP, ecommerce) ' +
        'administra las empresas que le pertenecen con su propia API key.',
      security: seguridad,
      body: jsonSchema(createOperatorBody),
      response: { 200: respuesta('Operador creado.'), 400: respuesta('Datos inválidos.') },
    },
  }, async (req, reply) => {
    try {
      const body = createOperatorBody.parse(req.body);
      const operator = await createOperator(body.operator_id, body.nombre);
      return reply.send(operator);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/operators', {
    schema: {
      tags: ['operadores'],
      summary: 'Listar operadores',
      security: seguridad,
      response: { 200: respuesta('Listado de operadores.') },
    },
  }, async (_req, reply) => reply.send(await listOperators()));

  app.get('/operators/:operatorId', {
    schema: {
      tags: ['operadores'],
      summary: 'Obtener un operador',
      security: seguridad,
      params: paramsOperator,
      response: { 200: respuesta('Datos del operador.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { operatorId } = req.params as { operatorId: string };
    const operator = await findOperator(operatorId);
    if (!operator) return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
    return reply.send(operator);
  });

  app.post('/operators/:operatorId/keys', {
    schema: {
      tags: ['operadores'],
      summary: 'Generar una API key para el operador',
      description:
        'Crea una nueva clave `skop_...`. La clave en claro **sólo se devuelve esta vez**; ' +
        'guárdala de forma segura. Soporta varias claves activas: úsalo para rotar con ' +
        'solapamiento (crear nueva, distribuir, revocar la vieja).',
      security: seguridad,
      params: paramsOperator,
      body: jsonSchema(createKeyBody),
      response: {
        200: respuesta('Clave creada. Incluye `key` (en claro, una sola vez).'),
        404: respuesta('Operador no encontrado.'),
      },
    },
  }, async (req, reply) => {
    try {
      const { operatorId } = req.params as { operatorId: string };
      const body = createKeyBody.parse(req.body);
      if (!(await findOperator(operatorId))) {
        return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
      }
      const created = await createApiKey(operatorId, body.label);
      return reply.send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/operators/:operatorId/keys', {
    schema: {
      tags: ['operadores'],
      summary: 'Listar las API keys del operador',
      description: 'Sin el hash. Incluye prefijo, etiqueta, último uso y estado de revocación.',
      security: seguridad,
      params: paramsOperator,
      response: { 200: respuesta('Claves del operador.'), 404: respuesta('Operador no encontrado.') },
    },
  }, async (req, reply) => {
    const { operatorId } = req.params as { operatorId: string };
    if (!(await findOperator(operatorId))) {
      return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
    }
    return reply.send(await listApiKeys(operatorId));
  });

  app.delete('/operators/:operatorId/keys/:keyId', {
    schema: {
      tags: ['operadores'],
      summary: 'Revocar una API key',
      description: 'Revocación suave: la clave deja de validar de inmediato. Úsalo para cerrar la rotación.',
      security: seguridad,
      params: paramsKey,
      response: { 200: respuesta('Clave revocada.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { operatorId, keyId } = req.params as { operatorId: string; keyId: string };
    const ok = await revokeApiKey(operatorId, keyId);
    if (!ok) return reply.code(404).send({ code: 404, message: 'Clave no encontrada o ya revocada' });
    return reply.send({ revoked: true });
  });

  app.post('/operators/:operatorId/activate', {
    schema: {
      tags: ['operadores'],
      summary: 'Activar/desactivar un operador',
      description: 'Un operador inactivo no puede administrar empresas (sus claves dejan de validar).',
      security: seguridad,
      params: paramsOperator,
      body: { type: 'object', required: ['activo'], properties: { activo: { type: 'boolean' } } },
      response: { 200: respuesta('Estado actualizado.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { operatorId } = req.params as { operatorId: string };
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    const ok = await setOperatorActive(operatorId, activo);
    if (!ok) return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
    return reply.send({ operator_id: operatorId, activo });
  });

  app.delete('/operators/:operatorId', {
    schema: {
      tags: ['operadores'],
      summary: 'Eliminar un operador',
      description:
        'Elimina el operador y sus claves. Sus empresas quedan huérfanas (operator_id = NULL) ' +
        'y son reasignables por el super-admin; no se pierde su historial de comprobantes.',
      security: seguridad,
      params: paramsOperator,
      response: { 200: respuesta('Operador eliminado.'), 404: respuesta('No existe.') },
    },
  }, async (req, reply) => {
    const { operatorId } = req.params as { operatorId: string };
    const ok = await deleteOperator(operatorId);
    if (!ok) return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
    return reply.send({ deleted: true });
  });

  app.post('/companies/:tenantId/reassign', {
    schema: {
      tags: ['operadores'],
      summary: 'Reasignar una empresa a otro operador',
      description:
        'Cambia el operador propietario de la empresa. El JWT del tenant NO cambia: el ERP del ' +
        'cliente final sigue emitiendo sin interrupción.',
      security: seguridad,
      params: paramsTenant,
      body: jsonSchema(reassignBody),
      response: { 200: respuesta('Empresa reasignada.'), 404: respuesta('Empresa u operador no existen.') },
    },
  }, async (req, reply) => {
    try {
      const { tenantId } = req.params as { tenantId: string };
      const body = reassignBody.parse(req.body);
      if (!(await findTenantRow(tenantId))) {
        return reply.code(404).send({ code: 404, message: 'Empresa no encontrada' });
      }
      if (!(await findOperator(body.operator_id))) {
        return reply.code(404).send({ code: 404, message: 'Operador no encontrado' });
      }
      await assignOperator(tenantId, body.operator_id);
      return reply.send({ tenant_id: tenantId, operator_id: body.operator_id });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
