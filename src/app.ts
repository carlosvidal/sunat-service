import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { authPlugin } from './http/auth.ts';
import { openapiPlugin } from './http/openapi.ts';
import { companyRoutes } from './http/routes/companies.ts';
import { saleRoutes } from './http/routes/sale.ts';
import { summaryRoutes } from './http/routes/summary.ts';
import { despatchRoutes } from './http/routes/despatch.ts';
import { retPerRoutes } from './http/routes/retention.ts';
import { documentRoutes } from './http/routes/documents.ts';
import { adminRoutes, backofficeUi } from './http/routes/admin.ts';
import { operatorRoutes } from './http/routes/operators.ts';
import { exampleRoutes } from './http/routes/examples-route.ts';
import { getPool } from './db/pool.ts';
import { redisEnabled } from './queue/index.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
      // Nunca registrar credenciales ni material criptográfico.
      redact: [
        'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-operator-key"]',
        'req.body.sol_pass', 'req.body.certificado', 'req.body.cert_password',
        'req.body.client_secret',
      ],
    },
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  // Los esquemas declarados en las rutas son SÓLO documentación: la validación
  // real la hace zod dentro de cada handler, que acepta coerciones (RUC como
  // número, importes como string) que un JSON Schema estricto rechazaría.
  app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));

  await app.register(openapiPlugin);
  await app.register(authPlugin);

  app.get('/health', {
    schema: {
      summary: 'Estado del servicio',
      description: 'Verifica la API, la conexión a PostgreSQL y si la cola está habilitada.',
      response: { 200: { description: 'Estado del servicio.' } },
    },
  }, async () => {
    const checks: Record<string, string> = { api: 'ok' };
    try {
      await getPool().query('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${(err as Error).message}`;
    }
    checks.queue = redisEnabled() ? 'configurada' : 'deshabilitada';
    const healthy = !Object.values(checks).some((v) => v.startsWith('error'));
    return { status: healthy ? 'ok' : 'degraded', checks };
  });

  await app.register(companyRoutes, { prefix: '/api/v1' });
  await app.register(operatorRoutes, { prefix: '/api/v1' });
  await app.register(saleRoutes('invoice'), { prefix: '/api/v1/invoice' });
  await app.register(saleRoutes('note'), { prefix: '/api/v1/note' });
  await app.register(summaryRoutes('summary'), { prefix: '/api/v1/summary' });
  await app.register(summaryRoutes('voided'), { prefix: '/api/v1/voided' });
  await app.register(despatchRoutes, { prefix: '/api/v1/despatch' });
  await app.register(retPerRoutes('20'), { prefix: '/api/v1/retention' });
  await app.register(retPerRoutes('40'), { prefix: '/api/v1/perception' });
  await app.register(documentRoutes, { prefix: '/api/v1' });
  await app.register(exampleRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(backofficeUi);

  return app;
}
