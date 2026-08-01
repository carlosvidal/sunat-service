import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db/pool.ts';

export type SunatState =
  | 'PENDIENTE' | 'EN_COLA_SUNAT' | 'ACEPTADO' | 'ACEPTADO_CON_OBSERVACIONES'
  | 'RECHAZADO' | 'EXCEPCION' | 'ANULADO';

export interface DocumentRow {
  id: string;
  tenant_id: string;
  tipo_comprobante: string;
  serie: string;
  correlativo: string;
  nombre_archivo: string;
  fecha_emision: Date;
  cliente_tipo_doc: string | null;
  cliente_num_doc: string | null;
  cliente_razon_social: string | null;
  moneda: string;
  monto_total: string;
  sunat_state: SunatState;
  sunat_code: string | null;
  sunat_description: string | null;
  sunat_notes: string[] | null;
  ticket: string | null;
  xml_path: string | null;
  cdr_path: string | null;
  pdf_path: string | null;
  digest_value: string | null;
  payload: unknown;
  retry_count: number;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: Date;
}

/**
 * Reserva el siguiente correlativo de una serie.
 *
 * El `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` es atómico: la fila de la
 * serie queda bloqueada durante la transacción, de modo que dos emisiones
 * concurrentes nunca obtienen el mismo número.
 */
export async function reservarCorrelativo(
  tenantId: string,
  tipoComprobante: string,
  serie: string,
): Promise<number> {
  const { rows } = await query<{ ultimo_numero: string }>(
    `INSERT INTO document_series (tenant_id, tipo_comprobante, serie, ultimo_numero)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, tipo_comprobante, serie)
     DO UPDATE SET ultimo_numero = document_series.ultimo_numero + 1
     RETURNING ultimo_numero`,
    [tenantId, tipoComprobante, serie],
  );
  return Number(rows[0]!.ultimo_numero);
}

/**
 * Devuelve el siguiente correlativo SIN consumirlo. Sólo para previsualizar
 * XML/PDF: la reserva real ocurre en `crearConCorrelativo`.
 */
export async function siguienteCorrelativo(
  tenantId: string,
  tipoComprobante: string,
  serie: string,
): Promise<number> {
  const { rows } = await query<{ ultimo_numero: string }>(
    `SELECT ultimo_numero FROM document_series
     WHERE tenant_id = $1 AND tipo_comprobante = $2 AND serie = $3`,
    [tenantId, tipoComprobante, serie],
  );
  return Number(rows[0]?.ultimo_numero ?? 0) + 1;
}

/** Sincroniza el contador cuando el emisor envía correlativos explícitos. */
export async function registrarCorrelativoManual(
  tenantId: string,
  tipoComprobante: string,
  serie: string,
  correlativo: number,
): Promise<void> {
  await query(
    `INSERT INTO document_series (tenant_id, tipo_comprobante, serie, ultimo_numero)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, tipo_comprobante, serie)
     DO UPDATE SET ultimo_numero = GREATEST(document_series.ultimo_numero, EXCLUDED.ultimo_numero)`,
    [tenantId, tipoComprobante, serie, correlativo],
  );
}

export interface CreateDocumentInput {
  tenantId: string;
  tipoComprobante: string;
  serie: string;
  correlativo: number;
  nombreArchivo: string;
  fechaEmision: string;
  clienteTipoDoc?: string;
  clienteNumDoc?: string;
  clienteRazonSocial?: string;
  moneda: string;
  montoTotal: number;
  state: SunatState;
  payload: unknown;
  /** Clave de idempotencia del cliente. Si se omite, la columna queda NULL y el
   *  índice único parcial no aplica. */
  idempotencyKey?: string;
}

export async function crearDocumento(input: CreateDocumentInput): Promise<DocumentRow> {
  const id = randomUUID();
  const { rows } = await query<DocumentRow>(
    `INSERT INTO electronic_documents (
        id, tenant_id, tipo_comprobante, serie, correlativo, nombre_archivo, fecha_emision,
        cliente_tipo_doc, cliente_num_doc, cliente_razon_social, moneda, monto_total,
        sunat_state, payload, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      id, input.tenantId, input.tipoComprobante, input.serie, input.correlativo,
      input.nombreArchivo, input.fechaEmision, input.clienteTipoDoc ?? null,
      input.clienteNumDoc ?? null, input.clienteRazonSocial ?? null, input.moneda,
      input.montoTotal, input.state, JSON.stringify(input.payload),
      input.idempotencyKey ?? null,
    ],
  );
  return rows[0]!;
}

export interface DocumentUpdate {
  state?: SunatState;
  code?: string | null;
  description?: string | null;
  notes?: string[] | null;
  ticket?: string | null;
  xmlPath?: string | null;
  cdrPath?: string | null;
  pdfPath?: string | null;
  digestValue?: string | null;
  lastError?: string | null;
  incrementRetry?: boolean;
}

export async function actualizarDocumento(id: string, u: DocumentUpdate): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };

  if (u.state !== undefined) push('sunat_state', u.state);
  if (u.code !== undefined) push('sunat_code', u.code);
  if (u.description !== undefined) push('sunat_description', u.description);
  if (u.notes !== undefined) push('sunat_notes', u.notes === null ? null : JSON.stringify(u.notes));
  if (u.ticket !== undefined) push('ticket', u.ticket);
  if (u.xmlPath !== undefined) push('xml_path', u.xmlPath);
  if (u.cdrPath !== undefined) push('cdr_path', u.cdrPath);
  if (u.pdfPath !== undefined) push('pdf_path', u.pdfPath);
  if (u.digestValue !== undefined) push('digest_value', u.digestValue);
  if (u.lastError !== undefined) push('last_error', u.lastError);
  if (u.incrementRetry) sets.push('retry_count = retry_count + 1');

  params.push(id);
  await query(`UPDATE electronic_documents SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function buscarDocumento(
  tenantId: string,
  tipoComprobante: string,
  serie: string,
  correlativo: number,
): Promise<DocumentRow | null> {
  const { rows } = await query<DocumentRow>(
    `SELECT * FROM electronic_documents
     WHERE tenant_id = $1 AND tipo_comprobante = $2 AND serie = $3 AND correlativo = $4`,
    [tenantId, tipoComprobante, serie, correlativo],
  );
  return rows[0] ?? null;
}

/**
 * Busca un documento por la clave de idempotencia del cliente. Es la consulta
 * previa de `/send`: si devuelve algo, la emisión ya ocurrió (o está en curso) y
 * no hay que volver a reservar correlativo.
 */
export async function buscarPorIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<DocumentRow | null> {
  const { rows } = await query<DocumentRow>(
    `SELECT * FROM electronic_documents
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function obtenerDocumento(id: string): Promise<DocumentRow | null> {
  const { rows } = await query<DocumentRow>('SELECT * FROM electronic_documents WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listarDocumentos(
  tenantId: string,
  filtros: { state?: SunatState; desde?: string; hasta?: string; limit?: number; offset?: number } = {},
): Promise<DocumentRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (filtros.state) {
    params.push(filtros.state);
    where.push(`sunat_state = $${params.length}`);
  }
  if (filtros.desde) {
    params.push(filtros.desde);
    where.push(`fecha_emision >= $${params.length}`);
  }
  if (filtros.hasta) {
    params.push(filtros.hasta);
    where.push(`fecha_emision <= $${params.length}`);
  }
  params.push(Math.min(filtros.limit ?? 50, 200));
  const limitIdx = params.length;
  params.push(filtros.offset ?? 0);

  const { rows } = await query<DocumentRow>(
    `SELECT * FROM electronic_documents WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Reserva correlativo y crea el documento en una sola transacción.
 *
 * Que ambas cosas compartan transacción es lo que hace segura la idempotencia:
 * si el INSERT choca contra `uq_documents_idempotency`, el rollback deshace
 * también el avance de `document_series`. El correlativo no se quema.
 */
export async function crearConCorrelativo(
  input: Omit<CreateDocumentInput, 'correlativo' | 'nombreArchivo'> & {
    correlativo?: number;
    nombreArchivo: (correlativo: number) => string;
  },
): Promise<DocumentRow> {
  return withTransaction(async (client) => {
    let correlativo = input.correlativo;
    if (correlativo === undefined) {
      const { rows } = await client.query<{ ultimo_numero: string }>(
        `INSERT INTO document_series (tenant_id, tipo_comprobante, serie, ultimo_numero)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (tenant_id, tipo_comprobante, serie)
         DO UPDATE SET ultimo_numero = document_series.ultimo_numero + 1
         RETURNING ultimo_numero`,
        [input.tenantId, input.tipoComprobante, input.serie],
      );
      correlativo = Number(rows[0]!.ultimo_numero);
    } else {
      await client.query(
        `INSERT INTO document_series (tenant_id, tipo_comprobante, serie, ultimo_numero)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, tipo_comprobante, serie)
         DO UPDATE SET ultimo_numero = GREATEST(document_series.ultimo_numero, EXCLUDED.ultimo_numero)`,
        [input.tenantId, input.tipoComprobante, input.serie, correlativo],
      );
    }

    const id = randomUUID();
    const { rows } = await client.query<DocumentRow>(
      `INSERT INTO electronic_documents (
          id, tenant_id, tipo_comprobante, serie, correlativo, nombre_archivo, fecha_emision,
          cliente_tipo_doc, cliente_num_doc, cliente_razon_social, moneda, monto_total,
          sunat_state, payload, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id, input.tenantId, input.tipoComprobante, input.serie, correlativo,
        input.nombreArchivo(correlativo), input.fechaEmision, input.clienteTipoDoc ?? null,
        input.clienteNumDoc ?? null, input.clienteRazonSocial ?? null, input.moneda,
        input.montoTotal, input.state, JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
      ],
    );
    return rows[0]!;
  });
}

/** Resúmenes (RC) y bajas (RA). */
export interface SummaryRow {
  id: string;
  tenant_id: string;
  tipo: 'RC' | 'RA';
  nombre_archivo: string;
  fecha_referencia: Date;
  ticket: string | null;
  sunat_state: string;
  sunat_code: string | null;
  sunat_description: string | null;
  sunat_notes: string[] | null;
  xml_path: string | null;
  cdr_path: string | null;
  digest_value: string | null;
  payload: unknown;
}

export async function crearResumen(input: {
  tenantId: string;
  tipo: 'RC' | 'RA';
  nombreArchivo: string;
  fechaReferencia: string;
  payload: unknown;
}): Promise<SummaryRow> {
  const id = randomUUID();
  const { rows } = await query<SummaryRow>(
    `INSERT INTO summary_documents (id, tenant_id, tipo, nombre_archivo, fecha_referencia, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, nombre_archivo) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
     RETURNING *`,
    [id, input.tenantId, input.tipo, input.nombreArchivo, input.fechaReferencia, JSON.stringify(input.payload)],
  );
  return rows[0]!;
}

export async function actualizarResumen(id: string, u: DocumentUpdate): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (u.state !== undefined) push('sunat_state', u.state);
  if (u.code !== undefined) push('sunat_code', u.code);
  if (u.description !== undefined) push('sunat_description', u.description);
  if (u.notes !== undefined) push('sunat_notes', u.notes === null ? null : JSON.stringify(u.notes));
  if (u.ticket !== undefined) push('ticket', u.ticket);
  if (u.xmlPath !== undefined) push('xml_path', u.xmlPath);
  if (u.cdrPath !== undefined) push('cdr_path', u.cdrPath);
  if (u.digestValue !== undefined) push('digest_value', u.digestValue);
  params.push(id);
  await query(`UPDATE summary_documents SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function buscarResumenPorTicket(tenantId: string, ticket: string): Promise<SummaryRow | null> {
  const { rows } = await query<SummaryRow>(
    'SELECT * FROM summary_documents WHERE tenant_id = $1 AND ticket = $2',
    [tenantId, ticket],
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Consultas para el backoffice (transversales a todos los tenants)
 * ------------------------------------------------------------------ */

export interface AdminFiltros {
  tenantId?: string;
  state?: SunatState;
  tipo?: string;
  /** Busca en serie-correlativo, nombre de archivo, RUC/razón social del cliente. */
  q?: string;
  desde?: string;
  hasta?: string;
  limit?: number;
  offset?: number;
}

export interface AdminDocumentRow extends DocumentRow {
  ruc: string;
  razon_social: string;
}

function adminWhere(f: AdminFiltros): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = ['1 = 1'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('$$', `$${params.length}`));
  };
  if (f.tenantId) add('d.tenant_id = $$', f.tenantId);
  if (f.state) add('d.sunat_state = $$', f.state);
  if (f.tipo) add('d.tipo_comprobante = $$', f.tipo);
  if (f.desde) add('d.fecha_emision >= $$', f.desde);
  if (f.hasta) add('d.fecha_emision <= $$', f.hasta);
  if (f.q) {
    add(
      `(d.nombre_archivo ILIKE '%' || $$ || '%'
        OR (d.serie || '-' || d.correlativo) ILIKE '%' || $$ || '%'
        OR d.cliente_num_doc ILIKE '%' || $$ || '%'
        OR d.cliente_razon_social ILIKE '%' || $$ || '%')`.replace(/\$\$/g, `$${params.length + 1}`),
      f.q,
    );
  }
  return { where: where.join(' AND '), params };
}

export async function listarDocumentosAdmin(f: AdminFiltros): Promise<{ rows: AdminDocumentRow[]; total: number }> {
  const { where, params } = adminWhere(f);
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;

  const [data, count] = await Promise.all([
    query<AdminDocumentRow>(
      `SELECT d.*, t.ruc, t.razon_social
       FROM electronic_documents d
       JOIN tenant_sunat_profiles t ON t.tenant_id = d.tenant_id
       WHERE ${where}
       ORDER BY d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM electronic_documents d
       JOIN tenant_sunat_profiles t ON t.tenant_id = d.tenant_id
       WHERE ${where}`,
      params,
    ),
  ]);

  return { rows: data.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export interface AdminResumen {
  porEstado: Array<{ state: SunatState; cantidad: number; monto: number }>;
  porTipo: Array<{ tipo: string; cantidad: number }>;
  ultimosErrores: Array<{
    id: string;
    nombre_archivo: string;
    sunat_state: string;
    sunat_code: string | null;
    sunat_description: string | null;
    last_error: string | null;
    created_at: Date;
  }>;
}

export async function resumenAdmin(f: AdminFiltros): Promise<AdminResumen> {
  const { where, params } = adminWhere(f);
  const [estados, tipos, errores] = await Promise.all([
    query<{ state: SunatState; cantidad: string; monto: string }>(
      `SELECT d.sunat_state AS state, COUNT(*)::text AS cantidad, COALESCE(SUM(d.monto_total), 0)::text AS monto
       FROM electronic_documents d
       JOIN tenant_sunat_profiles t ON t.tenant_id = d.tenant_id
       WHERE ${where}
       GROUP BY d.sunat_state`,
      params,
    ),
    query<{ tipo: string; cantidad: string }>(
      `SELECT d.tipo_comprobante AS tipo, COUNT(*)::text AS cantidad
       FROM electronic_documents d
       JOIN tenant_sunat_profiles t ON t.tenant_id = d.tenant_id
       WHERE ${where}
       GROUP BY d.tipo_comprobante
       ORDER BY d.tipo_comprobante`,
      params,
    ),
    query<AdminResumen['ultimosErrores'][number]>(
      `SELECT d.id, d.nombre_archivo, d.sunat_state, d.sunat_code, d.sunat_description, d.last_error, d.created_at
       FROM electronic_documents d
       JOIN tenant_sunat_profiles t ON t.tenant_id = d.tenant_id
       WHERE ${where} AND d.sunat_state IN ('RECHAZADO', 'EXCEPCION')
       ORDER BY d.created_at DESC
       LIMIT 15`,
      params,
    ),
  ]);

  return {
    porEstado: estados.rows.map((r) => ({ state: r.state, cantidad: Number(r.cantidad), monto: Number(r.monto) })),
    porTipo: tipos.rows.map((r) => ({ tipo: r.tipo, cantidad: Number(r.cantidad) })),
    ultimosErrores: errores.rows,
  };
}

export async function obtenerResumenPorId(id: string): Promise<SummaryRow | null> {
  const { rows } = await query<SummaryRow>('SELECT * FROM summary_documents WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Resúmenes (RC) y bajas (RA) recientes, para el panel de monitoreo. */
export async function listarResumenesAdmin(tenantId?: string, limit = 25): Promise<SummaryRow[]> {
  const params: unknown[] = [];
  let where = '1 = 1';
  if (tenantId) {
    params.push(tenantId);
    where = 'tenant_id = $1';
  }
  params.push(Math.min(limit, 100));
  const { rows } = await query<SummaryRow>(
    `SELECT * FROM summary_documents WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
