import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { config } from '../config.ts';
import { findTenant, loadSecrets, type TenantRow, type TenantSecrets } from '../repositories/tenants.ts';
import { verifyOperatorApiKey, type OperatorRow } from '../repositories/operators.ts';

export interface TenantContext {
  tenant: TenantRow;
  secrets: () => Promise<TenantSecrets>;
}

export interface OperatorContext {
  operator: OperatorRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantCtx?: TenantContext;
    operatorCtx?: OperatorContext;
  }
  interface FastifyInstance {
    /** Exige el token JWT de una empresa y carga su contexto. */
    requireTenant: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige la clave maestra de la plataforma (super-admin: operadores + backoffice). */
    requireMasterKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige una API key de operador válida y carga su contexto. */
    requireOperator: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { tenant_id: string; ruc: string };
    user: { tenant_id: string; ruc: string };
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorate('requireMasterKey', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.masterApiKey) {
      return reply.code(500).send({ code: 500, message: 'MASTER_API_KEY no está configurado en el servidor' });
    }
    const provided = req.headers['x-api-key'];
    if (provided !== config.masterApiKey) {
      return reply.code(401).send({ code: 401, message: 'X-API-Key inválido' });
    }
  });

  app.decorate('requireTenant', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ code: 401, message: 'Token inválido o ausente' });
    }
    const tenant = await findTenant(req.user.tenant_id);
    if (!tenant || !tenant.activo) {
      return reply.code(401).send({ code: 401, message: 'La empresa no existe o está inactiva' });
    }
    // Los secretos se descifran de forma diferida: sólo si la ruta los necesita.
    let cached: Promise<TenantSecrets> | undefined;
    req.tenantCtx = {
      tenant,
      secrets: () => (cached ??= loadSecrets(tenant)),
    };
  });

  app.decorate('requireOperator', async (req: FastifyRequest, reply: FastifyReply) => {
    // La clave de operador se admite en su cabecera propia o como Bearer.
    // (Un ERP que emite usa el JWT del tenant; aquí hablamos del operador que
    // administra empresas, así que la cabecera propia evita ambigüedades.)
    const header = req.headers['x-operator-key'];
    const auth = req.headers.authorization;
    let provided: string | undefined;
    if (typeof header === 'string' && header.length > 0) {
      provided = header;
    } else if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
      provided = auth.replace(/^bearer\s+/i, '').trim();
    }
    if (!provided) {
      return reply.code(401).send({ code: 401, message: 'API key de operador ausente' });
    }
    const verified = await verifyOperatorApiKey(provided);
    if (!verified) {
      return reply.code(401).send({ code: 401, message: 'API key de operador inválida' });
    }
    req.operatorCtx = { operator: verified.operator };
  });
});

export function tenantCtx(req: FastifyRequest): TenantContext {
  if (!req.tenantCtx) throw new Error('La ruta requiere el hook requireTenant');
  return req.tenantCtx;
}

export function operatorCtx(req: FastifyRequest): OperatorContext {
  if (!req.operatorCtx) throw new Error('La ruta requiere el hook requireOperator');
  return req.operatorCtx;
}

export function issueTenantToken(app: FastifyInstance, tenant: TenantRow): string {
  // Sin expiración: el token identifica a la empresa, no a una sesión.
  return app.jwt.sign({ tenant_id: tenant.tenant_id, ruc: tenant.ruc });
}
