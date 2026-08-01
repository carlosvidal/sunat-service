/**
 * Tests de integración del modelo de operadores (multi-operador).
 *
 * Cubren: creación de operadores y claves, propiedad 1:N de empresas, aislamiento
 * entre operadores, prevención de robo de empresas (409), rotación con
 * solapamiento y reasignación por super-admin.
 *
 * Requiere Postgres en localhost:5434 (ver docker-compose del proyecto). Si no
 * está disponible —p. ej. el job de CI `verificar`, que no levanta BD— la suite
 * entera se salta limpiamente; los tests unitarios siguen corriendo con `pnpm test`.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupIntegrationSuite, createOperatorWithKey, cleanTablesBeforeEach, type IntegrationCtx } from './helpers.ts';

const ctx: IntegrationCtx = { app: null, masterKey: '', disponible: false };

/** Genera un .pfx autofirmado (BETA) para los tests de alta de empresa. */
async function selfSignedPfx(ruc: string): Promise<{ cert: string; pass: string }> {
  const { generateSelfSignedPfx } = await import('../src/security/certificate.ts');
  const pass = 'test-pass-123';
  const { pfx } = generateSelfSignedPfx(ruc, 'EMPRESA TEST', pass);
  return { cert: pfx.toString('base64'), pass };
}

/** Cuerpo mínimo para POST /companies. */
function companyBody(tenantId: string, ruc: string, cert: string, pass: string) {
  return {
    tenant_id: tenantId,
    ruc,
    razon_social: 'EMPRESA TEST S.A.C.',
    domicilio_fiscal: { ubigueo: '150101', direccion: 'AV LIMA 100', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA' },
    sol_user: 'MODDATOS',
    sol_pass: 'MODDATOS',
    certificado: cert,
    cert_password: pass,
    environment: 'beta',
  };
}

describe('operadores (integración)', function () {
  setupIntegrationSuite(ctx, 'operators');

  // Si no hay Postgres, saltamos toda la suite para no romper el CI.
  before(function () {
    if (!ctx.disponible) this.skip();
  });

  cleanTablesBeforeEach(ctx);

  test('hashing scrypt: ida y vuelta y verificación fallida', async () => {
    const { hashApiKey, verifyApiKey } = await import('../src/security/apikey.ts');
    const h = await hashApiKey('skop_supersecreto');
    assert.equal(await verifyApiKey('skop_supersecreto', h), true);
    assert.equal(await verifyApiKey('skop_otra', h), false);
    assert.equal(await verifyApiKey('skop_supersecreto', 'scrypt$mal$formado'), false);
  });

  test('super-admin crea operador y le genera una API key (skop_)', async () => {
    const { operatorId, key } = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    assert.equal(operatorId, 'pms-a');
    assert.match(key, /^skop_/);
    assert.ok(key.length > 30);
  });

  test('operador crea empresa y queda asociada a él', async () => {
    const { key } = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    const { cert, pass } = await selfSignedPfx('20000000001');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': key },
      payload: companyBody('tienda-1', '20000000001', cert, pass),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { operator_id: string; token: string };
    assert.equal(body.operator_id, 'pms-a');
    assert.ok(body.token);
  });

  test('operador sólo ve sus empresas (aislamiento 1:N)', async () => {
    const a = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    const b = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-b');
    const { cert, pass } = await selfSignedPfx('20000000001');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': a.key },
      payload: companyBody('tienda-1', '20000000001', cert, pass),
    });

    const resA = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': a.key } });
    const resB = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': b.key } });
    assert.equal((resA.json() as unknown[]).length, 1);
    assert.equal((resB.json() as unknown[]).length, 0);

    // Acceso directo a empresa ajena => 404 (no revela existencia).
    const cross = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies/tienda-1', headers: { 'x-operator-key': b.key } });
    assert.equal(cross.statusCode, 404);
  });

  test('operador B no puede sobrescribir empresa del operador A (409)', async () => {
    const a = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    const b = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-b');
    const { cert, pass } = await selfSignedPfx('20000000001');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': a.key },
      payload: companyBody('tienda-1', '20000000001', cert, pass),
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': b.key },
      payload: companyBody('tienda-1', '20000000001', cert, pass),
    });
    assert.equal(res.statusCode, 409);
  });

  test('rotación: nueva clave, ambas válidas; al revocar la vieja sólo queda la nueva', async () => {
    const op = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    // Segunda clave.
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/operators/pms-a/keys',
      headers: { 'x-api-key': ctx.masterKey },
      payload: { label: 'nueva' },
    });
    const newKey = (res2.json() as { key: string }).key;

    // Ambas validan para listar empresas.
    const r1 = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': op.key } });
    const r2 = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': newKey } });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);

    // Revocar la vieja.
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/operators/pms-a/keys', headers: { 'x-api-key': ctx.masterKey } });
    const oldKeyId = (list.json() as { id: string; label: string | null }[]).find((k) => k.label === 'test')!.id;
    const rev = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/operators/pms-a/keys/${oldKeyId}`,
      headers: { 'x-api-key': ctx.masterKey },
    });
    assert.equal(rev.statusCode, 200);

    // La vieja ya no valida; la nueva sí.
    const r1b = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': op.key } });
    const r2b = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { 'x-operator-key': newKey } });
    assert.equal(r1b.statusCode, 401);
    assert.equal(r2b.statusCode, 200);
  });

  test('reasignación por super-admin: el operador destino ve la empresa y el origen deja de verla', async () => {
    const a = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    const b = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-b');
    const { cert, pass } = await selfSignedPfx('20000000001');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': a.key },
      payload: companyBody('tienda-1', '20000000001', cert, pass),
    });

    const reassign = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/companies/tienda-1/reassign',
      headers: { 'x-api-key': ctx.masterKey },
      payload: { operator_id: 'pms-b' },
    });
    assert.equal(reassign.statusCode, 200);

    // Antes dueño veía, ahora no; destino ahora sí.
    const ra = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies/tienda-1', headers: { 'x-operator-key': a.key } });
    const rb = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies/tienda-1', headers: { 'x-operator-key': b.key } });
    assert.equal(ra.statusCode, 404);
    assert.equal(rb.statusCode, 200);
  });

  test('sin API key de operador, /companies devuelve 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies' });
    assert.equal(res.statusCode, 401);
  });

  test('clave de operador en Authorization: Bearer también funciona', async () => {
    const { key } = await createOperatorWithKey(ctx.app, ctx.masterKey, 'pms-a');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/companies', headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.statusCode, 200);
  });
});
