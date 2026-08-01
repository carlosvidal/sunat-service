/**
 * Tests de integración de la idempotencia de emisión.
 *
 * El invariante que protegen: un reintento con la misma `Idempotency-Key` nunca
 * emite un comprobante duplicado ni consume otro correlativo.
 *
 * Ninguno de estos tests llega a SUNAT. Los que ejercitan `/send` siembran el
 * documento en la base y comprueban que el handler corta antes de emitir; el que
 * ejercita la colisión trabaja contra el repositorio, que es donde vive la
 * garantía transaccional.
 *
 * Requiere Postgres en localhost:5434. Sin él, la suite se salta limpiamente,
 * igual que `operators.test.ts`.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupIntegrationSuite, createOperatorWithKey, cleanTablesBeforeEach, type IntegrationCtx } from './helpers.ts';

const ctx: IntegrationCtx = { app: null, masterKey: '', disponible: false };

const TENANT_ID = 'tienda-idem';
const RUC = '20000000001';

/** Da de alta una empresa y devuelve su JWT de emisión. */
async function crearEmpresa(): Promise<string> {
  const { key } = await createOperatorWithKey(ctx.app!, ctx.masterKey, 'op-idem');
  const { generateSelfSignedPfx } = await import('../src/security/certificate.ts');
  const pass = 'test-pass-123';
  const { pfx } = generateSelfSignedPfx(RUC, 'EMPRESA TEST', pass);
  const res = await ctx.app!.inject({
    method: 'POST',
    url: '/api/v1/companies',
    headers: { 'x-operator-key': key },
    payload: {
      tenant_id: TENANT_ID,
      ruc: RUC,
      razon_social: 'EMPRESA TEST S.A.C.',
      domicilio_fiscal: { ubigueo: '150101', direccion: 'AV LIMA 100', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA' },
      sol_user: 'MODDATOS',
      sol_pass: 'MODDATOS',
      certificado: pfx.toString('base64'),
      cert_password: pass,
      environment: 'beta',
    },
  });
  assert.equal(res.statusCode, 200, `alta de empresa falló: ${res.body}`);
  return (res.json() as { token: string }).token;
}

/** Payload mínimo de boleta; nunca llega a SUNAT en esta suite. */
const BOLETA = {
  tipoDoc: '03',
  serie: 'B001',
  tipoMoneda: 'PEN',
  client: { tipoDoc: '1', numDoc: '46543212', rznSocial: 'JUAN PEREZ' },
  details: [{ codProducto: 'P1', unidad: 'NIU', descripcion: 'POLO', cantidad: 1, mtoValorUnitario: 100 }],
};

/** Lee el contador de la serie; 0 si aún no existe. */
async function ultimoNumero(serie: string): Promise<number> {
  const { query } = await import('../src/db/pool.ts');
  const { rows } = await query<{ ultimo_numero: string }>(
    `SELECT ultimo_numero FROM document_series
      WHERE tenant_id = $1 AND tipo_comprobante = '03' AND serie = $2`,
    [TENANT_ID, serie],
  );
  return Number(rows[0]?.ultimo_numero ?? 0);
}

describe('idempotencia de emisión (integración)', function () {
  setupIntegrationSuite(ctx, 'idempotency');

  before(function () {
    if (!ctx.disponible) this.skip();
  });

  cleanTablesBeforeEach(ctx);

  test('la clave colisiona y el rollback devuelve el correlativo', async () => {
    await crearEmpresa();
    const repo = await import('../src/repositories/documents.ts');
    const clave = 'clave-repetida';

    const doc = async () => repo.crearConCorrelativo({
      tenantId: TENANT_ID,
      tipoComprobante: '03',
      serie: 'B001',
      nombreArchivo: (n) => `${RUC}-03-B001-${n}`,
      fechaEmision: '2026-07-31',
      moneda: 'PEN',
      montoTotal: 118,
      state: 'PENDIENTE',
      payload: BOLETA,
      idempotencyKey: clave,
    });

    const primero = await doc();
    assert.equal(Number(primero.correlativo), 1);
    assert.equal(primero.idempotency_key, clave);
    assert.equal(await ultimoNumero('B001'), 1);

    // El segundo intento choca contra uq_documents_idempotency.
    await assert.rejects(doc, (err: { code?: string; constraint?: string }) => {
      assert.equal(err.code, '23505');
      assert.equal(err.constraint, 'uq_documents_idempotency');
      return true;
    });

    // Lo que de verdad importa: el correlativo NO se quemó, porque el INSERT y
    // la reserva comparten transacción y el rollback deshizo ambos.
    assert.equal(await ultimoNumero('B001'), 1);
    const { query } = await import('../src/db/pool.ts');
    const { rows } = await query('SELECT id FROM electronic_documents WHERE idempotency_key = $1', [clave]);
    assert.equal(rows.length, 1);
  });

  test('sin clave se pueden crear dos documentos: el índice es parcial', async () => {
    await crearEmpresa();
    const repo = await import('../src/repositories/documents.ts');
    const doc = async () => repo.crearConCorrelativo({
      tenantId: TENANT_ID,
      tipoComprobante: '03',
      serie: 'B001',
      nombreArchivo: (n) => `${RUC}-03-B001-${n}`,
      fechaEmision: '2026-07-31',
      moneda: 'PEN',
      montoTotal: 118,
      state: 'PENDIENTE',
      payload: BOLETA,
    });

    assert.equal(Number((await doc()).correlativo), 1);
    assert.equal(Number((await doc()).correlativo), 2);
    assert.equal(await ultimoNumero('B001'), 2);
  });

  test('/send con una clave ya emitida responde el replay sin tocar SUNAT', async () => {
    const token = await crearEmpresa();
    const repo = await import('../src/repositories/documents.ts');
    const clave = 'clave-ya-emitida';

    const row = await repo.crearConCorrelativo({
      tenantId: TENANT_ID,
      tipoComprobante: '03',
      serie: 'B001',
      nombreArchivo: (n) => `${RUC}-03-B001-${n}`,
      fechaEmision: '2026-07-31',
      moneda: 'PEN',
      montoTotal: 118,
      state: 'PENDIENTE',
      payload: BOLETA,
      idempotencyKey: clave,
    });
    await repo.actualizarDocumento(row.id, {
      state: 'ACEPTADO',
      code: '0',
      description: 'La Boleta numero B001-1, ha sido aceptada',
      digestValue: 'hash-de-prueba',
    });

    const res = await ctx.app!.inject({
      method: 'POST',
      url: '/api/v1/invoice/send',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': clave },
      payload: BOLETA,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['idempotent-replay'], 'true');
    const body = res.json() as {
      documentId: string; state: string; hash: string;
      sunatResponse: { success: boolean; cdrResponse: { code: string; accepted: boolean } };
    };
    assert.equal(body.documentId, row.id);
    assert.equal(body.state, 'ACEPTADO');
    assert.equal(body.hash, 'hash-de-prueba');
    assert.equal(body.sunatResponse.success, true);
    assert.equal(body.sunatResponse.cdrResponse.code, '0');

    // El replay no consumió otro correlativo ni creó otro documento.
    assert.equal(await ultimoNumero('B001'), 1);
    const { query } = await import('../src/db/pool.ts');
    const { rows } = await query('SELECT id FROM electronic_documents');
    assert.equal(rows.length, 1);
  });

  test('/send con una emisión en curso responde 409 con la identidad del documento', async () => {
    const token = await crearEmpresa();
    const repo = await import('../src/repositories/documents.ts');
    const clave = 'clave-en-vuelo';

    const row = await repo.crearConCorrelativo({
      tenantId: TENANT_ID,
      tipoComprobante: '03',
      serie: 'B001',
      nombreArchivo: (n) => `${RUC}-03-B001-${n}`,
      fechaEmision: '2026-07-31',
      moneda: 'PEN',
      montoTotal: 118,
      state: 'PENDIENTE',
      payload: BOLETA,
      idempotencyKey: clave,
    });

    const res = await ctx.app!.inject({
      method: 'POST',
      url: '/api/v1/invoice/send',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': clave },
      payload: BOLETA,
    });

    assert.equal(res.statusCode, 409);
    const body = res.json() as { documentId: string; serie: string; correlativo: number; state: string; retryable: boolean };
    assert.equal(body.documentId, row.id);
    assert.equal(body.serie, 'B001');
    assert.equal(body.correlativo, 1);
    assert.equal(body.state, 'PENDIENTE');
    assert.equal(body.retryable, true);
    assert.equal(await ultimoNumero('B001'), 1);
  });

  test('la clave es por empresa: la misma clave en otra empresa no colisiona', async () => {
    await crearEmpresa();
    const { key } = await createOperatorWithKey(ctx.app!, ctx.masterKey, 'op-idem-2');
    const { generateSelfSignedPfx } = await import('../src/security/certificate.ts');
    const otroRuc = '20000000002';
    const { pfx } = generateSelfSignedPfx(otroRuc, 'OTRA EMPRESA', 'p');
    const alta = await ctx.app!.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { 'x-operator-key': key },
      payload: {
        tenant_id: 'tienda-idem-2',
        ruc: otroRuc,
        razon_social: 'OTRA EMPRESA S.A.C.',
        domicilio_fiscal: { ubigueo: '150101', direccion: 'AV LIMA 200', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA' },
        sol_user: 'MODDATOS',
        sol_pass: 'MODDATOS',
        certificado: pfx.toString('base64'),
        cert_password: 'p',
        environment: 'beta',
      },
    });
    assert.equal(alta.statusCode, 200, `alta de la 2ª empresa falló: ${alta.body}`);

    const repo = await import('../src/repositories/documents.ts');
    const clave = 'misma-clave-distinta-empresa';
    const base = {
      tipoComprobante: '03',
      serie: 'B001',
      nombreArchivo: (n: number) => `03-B001-${n}`,
      fechaEmision: '2026-07-31',
      moneda: 'PEN',
      montoTotal: 118,
      state: 'PENDIENTE' as const,
      payload: BOLETA,
      idempotencyKey: clave,
    };

    const a = await repo.crearConCorrelativo({ ...base, tenantId: TENANT_ID });
    const b = await repo.crearConCorrelativo({ ...base, tenantId: 'tienda-idem-2' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.idempotency_key, b.idempotency_key);
  });
});
