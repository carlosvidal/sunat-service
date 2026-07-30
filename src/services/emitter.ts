import { buildSaleXml } from '../ubl/sale.ts';
import { buildSummaryXml, buildVoidedXml } from '../ubl/summary.ts';
import { signUbl } from '../ubl/sign.ts';
import { zipXml } from '../sunat/zip.ts';
import { SunatSoapClient } from '../sunat/soap.ts';
import type { CdrResponse } from '../sunat/cdr.ts';
import { completarTotales, validarTotales } from '../domain/totals.ts';
import type {
  CompanyInput, DespatchInput, InvoiceInput, NoteInput, PerceptionInput,
  RetentionInput, SummaryInput, VoidedInput,
} from '../domain/schemas.ts';
import type { SaleDoc, SummaryDoc, VoidedDoc } from '../ubl/types.ts';
import { companyOf, type TenantRow, type TenantSecrets } from '../repositories/tenants.ts';
import * as repo from '../repositories/documents.ts';
import { artifactKey, getStorage } from '../storage/index.ts';
import { nombreBaja, nombreCpe, nombreResumen } from './naming.ts';
import { isoDate, todayPeru } from '../util/dates.ts';
import { renderSalePdf } from '../pdf/sale-pdf.ts';
import { renderRetPerPdf } from '../pdf/retention-pdf.ts';
import {
  buildPerceptionXml, buildRetentionXml, normalizar,
  type PerceptionDoc, type RetentionDoc,
} from '../ubl/retention.ts';
import { SunatError } from '../sunat/errors.ts';
import { buildDespatchXml, type DespatchDoc } from '../ubl/despatch.ts';
import { GreRestClient } from '../sunat/gre.ts';
import { parseCdrZip } from '../sunat/cdr.ts';
import { query } from '../db/pool.ts';

export class ValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

function clienteState(cdr: CdrResponse): repo.SunatState {
  if (cdr.severity === 'aceptado') return 'ACEPTADO';
  if (cdr.severity === 'observacion') return 'ACEPTADO_CON_OBSERVACIONES';
  if (cdr.severity === 'rechazado') return 'RECHAZADO';
  return 'EXCEPCION';
}

function soapClient(tenant: TenantRow, secrets: TenantSecrets): SunatSoapClient {
  return new SunatSoapClient(tenant.ambiente, {
    ruc: tenant.ruc,
    solUser: tenant.sol_user,
    solPass: secrets.solPass,
  });
}

/**
 * Normaliza el payload: resuelve el emisor desde el perfil del tenant,
 * completa importes faltantes y valida coherencia.
 */
export function prepararVenta(
  tenant: TenantRow,
  input: InvoiceInput | NoteInput,
  correlativo?: number,
): SaleDoc {
  const company = input.company ?? companyOf(tenant);
  if (company.ruc !== tenant.ruc) {
    throw new ValidationError([`El RUC del emisor (${company.ruc}) no corresponde a la empresa autenticada (${tenant.ruc})`]);
  }
  const numero = correlativo ?? (input.correlativo ? Number(input.correlativo) : undefined);
  if (numero === undefined || !Number.isFinite(numero)) {
    throw new ValidationError(['Debe indicar el correlativo o solicitar uno automático']);
  }

  const completo = completarTotales(input);
  const errores = validarTotales(completo);
  if (errores.length > 0) throw new ValidationError(errores);

  return {
    ...completo,
    company,
    correlativo: String(numero),
    fechaEmision: input.fechaEmision ?? `${todayPeru()}T00:00:00-05:00`,
  } as SaleDoc;
}

export interface SignedArtifacts {
  doc: SaleDoc;
  fileName: string;
  xml: string;
  digestValue: string;
  zip: Buffer;
}

/** Genera y firma el XML de una venta (sin enviarlo a SUNAT). */
export async function firmarVenta(tenant: TenantRow, secrets: TenantSecrets, doc: SaleDoc): Promise<SignedArtifacts> {
  const fileName = nombreCpe(tenant.ruc, doc.tipoDoc, doc.serie, doc.correlativo);
  const unsigned = buildSaleXml(doc);
  const signed = signUbl(unsigned, secrets.certificate.privateKeyPem, secrets.certificate.certificatePem);
  return { doc, fileName, xml: signed.xml, digestValue: signed.digestValue, zip: await zipXml(fileName, signed.xml) };
}

export interface EmisionResult {
  documentId: string;
  fileName: string;
  xml: string;
  hash: string;
  state: repo.SunatState;
  cdr?: CdrResponse;
  paths: { xml?: string; cdr?: string; pdf?: string };
  error?: string;
}

/**
 * Flujo completo de emisión de una Factura/Boleta/Nota:
 * correlativo → XML → firma → zip → SUNAT → CDR → artefactos.
 */
export async function emitirVenta(
  tenant: TenantRow,
  secrets: TenantSecrets,
  input: InvoiceInput | NoteInput,
  options: { generarPdf?: boolean; documentId?: string } = {},
): Promise<EmisionResult> {
  const storage = getStorage();
  const explicito = input.correlativo ? Number(input.correlativo) : undefined;

  let row: repo.DocumentRow;
  if (options.documentId) {
    const existente = await repo.obtenerDocumento(options.documentId);
    if (!existente) throw new Error(`Documento ${options.documentId} no encontrado`);
    row = existente;
  } else {
    const preview = prepararVenta(tenant, input, explicito ?? 0);
    row = await repo.crearConCorrelativo({
      tenantId: tenant.tenant_id,
      tipoComprobante: preview.tipoDoc,
      serie: preview.serie,
      correlativo: explicito,
      nombreArchivo: (n) => nombreCpe(tenant.ruc, preview.tipoDoc, preview.serie, n),
      fechaEmision: isoDate(preview.fechaEmision),
      clienteTipoDoc: preview.client.tipoDoc,
      clienteNumDoc: preview.client.numDoc,
      clienteRazonSocial: preview.client.rznSocial,
      moneda: preview.tipoMoneda,
      montoTotal: preview.mtoImpVenta ?? 0,
      state: 'PENDIENTE',
      payload: input,
    });
  }

  const doc = prepararVenta(tenant, input, Number(row.correlativo));
  const artifacts = await firmarVenta(tenant, secrets, doc);
  const fecha = isoDate(doc.fechaEmision);

  const xmlPath = await storage.put(
    artifactKey(tenant.ruc, fecha, artifacts.fileName, 'xml'),
    Buffer.from(artifacts.xml, 'utf8'),
    'application/xml',
  );
  await repo.actualizarDocumento(row.id, { xmlPath, digestValue: artifacts.digestValue, state: 'EN_COLA_SUNAT' });

  const paths: EmisionResult['paths'] = { xml: xmlPath };
  const base: EmisionResult = {
    documentId: row.id,
    fileName: artifacts.fileName,
    xml: artifacts.xml,
    hash: artifacts.digestValue,
    state: 'EN_COLA_SUNAT',
    paths,
  };

  let cdr: CdrResponse;
  try {
    const result = await soapClient(tenant, secrets).sendBill(artifacts.fileName, artifacts.zip);
    cdr = result.cdr;
    paths.cdr = await storage.put(
      artifactKey(tenant.ruc, fecha, `R-${artifacts.fileName}`, 'zip'),
      result.cdrZip,
      'application/zip',
    );
  } catch (err) {
    const isSunat = err instanceof SunatError;
    const state: repo.SunatState = isSunat && !err.retryable ? 'RECHAZADO' : 'EXCEPCION';
    await repo.actualizarDocumento(row.id, {
      state,
      code: isSunat ? err.code : null,
      description: (err as Error).message,
      lastError: (err as Error).message,
      incrementRetry: true,
    });
    if (options.generarPdf !== false) {
      paths.pdf = await guardarPdf(tenant, doc, artifacts.digestValue, fecha, row.id);
    }
    return { ...base, state, error: (err as Error).message };
  }

  const state = clienteState(cdr);
  await repo.actualizarDocumento(row.id, {
    state,
    code: cdr.code,
    description: cdr.description,
    notes: cdr.notes.length ? cdr.notes : null,
    cdrPath: paths.cdr ?? null,
  });

  if (options.generarPdf !== false) {
    paths.pdf = await guardarPdf(tenant, doc, artifacts.digestValue, fecha, row.id, cdr.description);
  }

  return { ...base, state, cdr };
}

async function guardarPdf(
  tenant: TenantRow,
  doc: SaleDoc,
  digestValue: string,
  fecha: string,
  documentId: string,
  observacion?: string,
): Promise<string | undefined> {
  try {
    const pdf = await renderSalePdf(doc, { digestValue, observacionSunat: observacion });
    const fileName = nombreCpe(tenant.ruc, doc.tipoDoc, doc.serie, doc.correlativo);
    const path = await getStorage().put(artifactKey(tenant.ruc, fecha, fileName, 'pdf'), pdf, 'application/pdf');
    await repo.actualizarDocumento(documentId, { pdfPath: path });
    return path;
  } catch (err) {
    // El PDF es una representación impresa: su falla no invalida la emisión.
    await repo.actualizarDocumento(documentId, { lastError: `PDF: ${(err as Error).message}` });
    return undefined;
  }
}

export interface ResumenResult {
  summaryId: string;
  fileName: string;
  xml: string;
  hash: string;
  ticket?: string;
  state: string;
  error?: string;
}

/** Envía un Resumen Diario de Boletas (RC). Devuelve el ticket de SUNAT. */
export async function emitirResumen(tenant: TenantRow, secrets: TenantSecrets, input: SummaryInput): Promise<ResumenResult> {
  const company = input.company ?? companyOf(tenant);
  // El ID/nombre del RC debe llevar la fecha de generación del resumen
  // (IssueDate = fecResumen); SUNAT rechaza con 2346 si no coinciden.
  const fechaResumen = input.fecResumen ?? input.fecGeneracion;
  const { name, xmlId } = nombreResumen(tenant.ruc, fechaResumen, input.correlativo);
  const doc: SummaryDoc = { ...input, company, xmlId };
  return enviarAsincrono(tenant, secrets, 'RC', name, buildSummaryXml(doc), fechaResumen, input);
}

/** Envía una Comunicación de Baja (RA). Devuelve el ticket de SUNAT. */
export async function emitirBaja(tenant: TenantRow, secrets: TenantSecrets, input: VoidedInput): Promise<ResumenResult> {
  const company = input.company ?? companyOf(tenant);
  const { name, xmlId } = nombreBaja(tenant.ruc, input.fecComunicacion ?? input.fecGeneracion, input.correlativo);
  const doc: VoidedDoc = { ...input, company, xmlId };
  return enviarAsincrono(tenant, secrets, 'RA', name, buildVoidedXml(doc), input.fecGeneracion, input);
}

async function enviarAsincrono(
  tenant: TenantRow,
  secrets: TenantSecrets,
  tipo: 'RC' | 'RA',
  fileName: string,
  unsignedXml: string,
  fechaReferencia: string,
  payload: unknown,
): Promise<ResumenResult> {
  const storage = getStorage();
  const signed = signUbl(unsignedXml, secrets.certificate.privateKeyPem, secrets.certificate.certificatePem);
  const row = await repo.crearResumen({
    tenantId: tenant.tenant_id,
    tipo,
    nombreArchivo: fileName,
    fechaReferencia: isoDate(fechaReferencia),
    payload,
  });

  const fecha = isoDate(fechaReferencia);
  const xmlPath = await storage.put(artifactKey(tenant.ruc, fecha, fileName, 'xml'), Buffer.from(signed.xml, 'utf8'), 'application/xml');
  await repo.actualizarResumen(row.id, { xmlPath, digestValue: signed.digestValue, state: 'EN_COLA_SUNAT' });

  try {
    const zip = await zipXml(fileName, signed.xml);
    const ticket = await soapClient(tenant, secrets).sendSummary(fileName, zip);
    await repo.actualizarResumen(row.id, { ticket, state: 'EN_COLA_SUNAT' });
    return { summaryId: row.id, fileName, xml: signed.xml, hash: signed.digestValue, ticket, state: 'EN_COLA_SUNAT' };
  } catch (err) {
    const isSunat = err instanceof SunatError;
    await repo.actualizarResumen(row.id, {
      state: isSunat && !err.retryable ? 'RECHAZADO' : 'EXCEPCION',
      code: isSunat ? err.code : null,
      description: (err as Error).message,
    });
    return {
      summaryId: row.id, fileName, xml: signed.xml, hash: signed.digestValue,
      state: 'EXCEPCION', error: (err as Error).message,
    };
  }
}

/** Consulta el estado de un ticket (RC/RA) y persiste la CDR si ya está lista. */
export async function consultarTicket(tenant: TenantRow, secrets: TenantSecrets, ticket: string) {
  const result = await soapClient(tenant, secrets).getStatus(ticket);
  const row = await repo.buscarResumenPorTicket(tenant.tenant_id, ticket);

  if (result.cdr && row) {
    const state = result.cdr.severity === 'aceptado'
      ? 'ACEPTADO'
      : result.cdr.severity === 'observacion' ? 'ACEPTADO_CON_OBSERVACIONES' : 'RECHAZADO';
    let cdrPath: string | undefined;
    if (result.cdrZip) {
      cdrPath = await getStorage().put(
        artifactKey(tenant.ruc, isoDate(row.fecha_referencia), `R-${row.nombre_archivo}`, 'zip'),
        result.cdrZip,
        'application/zip',
      );
    }
    await repo.actualizarResumen(row.id, {
      state: state as repo.SunatState,
      code: result.cdr.code,
      description: result.cdr.description,
      notes: result.cdr.notes.length ? result.cdr.notes : null,
      cdrPath: cdrPath ?? null,
    });
  }

  return {
    ticket,
    statusCode: result.statusCode,
    /** 98 = SUNAT aún está procesando el resumen. */
    procesando: result.statusCode === '98',
    cdrResponse: result.cdr,
    cdrZip: result.cdrZip?.toString('base64'),
  };
}

/** Consulta en SUNAT la CDR de un comprobante ya enviado. */
export async function consultarCdr(
  tenant: TenantRow,
  secrets: TenantSecrets,
  tipoDoc: string,
  serie: string,
  correlativo: string,
) {
  const result = await soapClient(tenant, secrets).getStatusCdr(tipoDoc, serie, correlativo);
  return {
    success: result.cdr?.accepted ?? false,
    code: result.statusCode,
    cdrResponse: result.cdr,
    cdrZip: result.cdrZip?.toString('base64'),
  };
}

/* ------------------------------------------------------------------ *
 * Guía de Remisión Electrónica (GRE) — API REST
 * ------------------------------------------------------------------ */

/** Busca el documento asociado a un ticket de GRE. */
function queryDocumentoPorTicket(tenantId: string, ticket: string) {
  return query<repo.DocumentRow>(
    'SELECT * FROM electronic_documents WHERE tenant_id = $1 AND ticket = $2',
    [tenantId, ticket],
  );
}

export function prepararGuia(tenant: TenantRow, input: DespatchInput, correlativo: number): DespatchDoc {
  const company = input.company ?? companyOf(tenant);
  if (company.ruc !== tenant.ruc) {
    throw new ValidationError([`El RUC del emisor (${company.ruc}) no corresponde a la empresa autenticada (${tenant.ruc})`]);
  }
  return {
    ...input,
    company,
    correlativo: String(correlativo),
    fechaEmision: input.fechaEmision ?? `${todayPeru()}T00:00:00-05:00`,
  };
}

function greClient(tenant: TenantRow, secrets: TenantSecrets): GreRestClient {
  if (!secrets.clientId || !secrets.clientSecret) {
    throw new ValidationError([
      'La empresa no tiene client_id/client_secret de la API SUNAT: son obligatorios para la nueva GRE',
    ]);
  }
  return new GreRestClient(tenant.ambiente, {
    ruc: tenant.ruc,
    solUser: tenant.sol_user,
    solPass: secrets.solPass,
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
  });
}

export interface GuiaResult {
  documentId: string;
  fileName: string;
  xml: string;
  hash: string;
  state: repo.SunatState;
  ticket?: string;
  paths: { xml?: string; cdr?: string };
  error?: string;
}

/** Emite una Guía de Remisión: XML firmado → zip → API REST → ticket. */
export async function emitirGuia(tenant: TenantRow, secrets: TenantSecrets, input: DespatchInput): Promise<GuiaResult> {
  const storage = getStorage();
  // Se valida el acceso a la API REST antes de consumir un correlativo.
  const cliente = greClient(tenant, secrets);
  const explicito = input.correlativo ? Number(input.correlativo) : undefined;
  const preview = prepararGuia(tenant, input, explicito ?? 0);

  const row = await repo.crearConCorrelativo({
    tenantId: tenant.tenant_id,
    tipoComprobante: preview.tipoDoc,
    serie: preview.serie,
    correlativo: explicito,
    nombreArchivo: (n) => nombreCpe(tenant.ruc, preview.tipoDoc, preview.serie, n),
    fechaEmision: isoDate(preview.fechaEmision),
    clienteTipoDoc: preview.destinatario.tipoDoc,
    clienteNumDoc: preview.destinatario.numDoc,
    clienteRazonSocial: preview.destinatario.rznSocial,
    moneda: 'PEN',
    montoTotal: 0,
    state: 'PENDIENTE',
    payload: input,
  });

  const doc = prepararGuia(tenant, input, Number(row.correlativo));
  const fileName = nombreCpe(tenant.ruc, doc.tipoDoc, doc.serie, doc.correlativo);
  const signed = signUbl(buildDespatchXml(doc), secrets.certificate.privateKeyPem, secrets.certificate.certificatePem);
  const fecha = isoDate(doc.fechaEmision);

  const xmlPath = await storage.put(artifactKey(tenant.ruc, fecha, fileName, 'xml'), Buffer.from(signed.xml, 'utf8'), 'application/xml');
  await repo.actualizarDocumento(row.id, { xmlPath, digestValue: signed.digestValue, state: 'EN_COLA_SUNAT' });

  const base: GuiaResult = {
    documentId: row.id, fileName, xml: signed.xml, hash: signed.digestValue,
    state: 'EN_COLA_SUNAT', paths: { xml: xmlPath },
  };

  try {
    const zip = await zipXml(fileName, signed.xml);
    const { numTicket } = await cliente.send(fileName, zip);
    await repo.actualizarDocumento(row.id, { ticket: numTicket });
    return { ...base, ticket: numTicket };
  } catch (err) {
    const isSunat = err instanceof SunatError;
    const state: repo.SunatState = isSunat && !err.retryable ? 'RECHAZADO' : 'EXCEPCION';
    await repo.actualizarDocumento(row.id, {
      state,
      code: isSunat ? err.code : null,
      description: (err as Error).message,
      lastError: (err as Error).message,
      incrementRetry: true,
    });
    return { ...base, state, error: (err as Error).message };
  }
}

/** Consulta el ticket de una guía y persiste la CDR cuando ya está disponible. */
export async function consultarTicketGuia(tenant: TenantRow, secrets: TenantSecrets, ticket: string) {
  const result = await greClient(tenant, secrets).status(ticket);
  const { rows } = await queryDocumentoPorTicket(tenant.tenant_id, ticket);
  const row = rows[0];

  let cdr: CdrResponse | undefined;
  let cdrPath: string | undefined;
  if (result.arcCdr) {
    const zip = Buffer.from(result.arcCdr, 'base64');
    cdr = await parseCdrZip(zip);
    if (row) {
      cdrPath = await getStorage().put(
        artifactKey(tenant.ruc, isoDate(row.fecha_emision), `R-${row.nombre_archivo}`, 'zip'),
        zip,
        'application/zip',
      );
    }
  }

  if (row) {
    const state: repo.SunatState = cdr
      ? (cdr.severity === 'aceptado' ? 'ACEPTADO' : cdr.severity === 'observacion' ? 'ACEPTADO_CON_OBSERVACIONES' : 'RECHAZADO')
      : result.error?.numError ? 'RECHAZADO' : 'EN_COLA_SUNAT';
    await repo.actualizarDocumento(row.id, {
      state,
      code: cdr?.code ?? result.error?.numError ?? null,
      description: cdr?.description ?? result.error?.desError ?? null,
      notes: cdr?.notes.length ? cdr.notes : null,
      cdrPath: cdrPath ?? null,
    });
  }

  return {
    ticket,
    codRespuesta: result.codRespuesta,
    /** '0' con indCdrGenerado '1' significa que la guía ya fue procesada. */
    procesando: !result.arcCdr && !result.error?.numError,
    cdrResponse: cdr,
    cdrZip: result.arcCdr,
    error: result.error,
  };
}

/* ------------------------------------------------------------------ *
 * Comprobantes de Retención (20) y Percepción (40)
 * ------------------------------------------------------------------ */

export type TipoRetPer = '20' | '40';

export function prepararRetPer<T extends RetentionInput | PerceptionInput>(
  tenant: TenantRow,
  input: T,
  correlativo: number,
): T & { company: CompanyInput; correlativo: string; fechaEmision: string } {
  const company = input.company ?? companyOf(tenant);
  if (company.ruc !== tenant.ruc) {
    throw new ValidationError([`El RUC del emisor (${company.ruc}) no corresponde a la empresa autenticada (${tenant.ruc})`]);
  }
  return {
    ...input,
    company,
    correlativo: String(correlativo),
    fechaEmision: input.fechaEmision ?? `${todayPeru()}T00:00:00-05:00`,
  };
}

export function xmlRetPer(tipo: TipoRetPer, doc: RetentionDoc | PerceptionDoc): string {
  return tipo === '20'
    ? buildRetentionXml(doc as RetentionDoc)
    : buildPerceptionXml(doc as PerceptionDoc);
}

/**
 * Emite un comprobante de retención o percepción. Se transmite por el web
 * service de "otros comprobantes" (distinto al de facturas y boletas).
 */
export async function emitirRetPer(
  tenant: TenantRow,
  secrets: TenantSecrets,
  tipo: TipoRetPer,
  input: RetentionInput | PerceptionInput,
  options: { generarPdf?: boolean; documentId?: string } = {},
): Promise<EmisionResult> {
  const storage = getStorage();
  const explicito = input.correlativo ? Number(input.correlativo) : undefined;
  const preview = prepararRetPer(tenant, input, explicito ?? 0);

  // Con documentId se reenvía un comprobante existente conservando su correlativo.
  const row = options.documentId
    ? await (async () => {
        const existente = await repo.obtenerDocumento(options.documentId!);
        if (!existente) throw new Error(`Documento ${options.documentId} no encontrado`);
        return existente;
      })()
    : await repo.crearConCorrelativo({
      tenantId: tenant.tenant_id,
      tipoComprobante: tipo,
      serie: preview.serie,
      correlativo: explicito,
      nombreArchivo: (n) => nombreCpe(tenant.ruc, tipo, preview.serie, n),
      fechaEmision: isoDate(preview.fechaEmision),
      clienteTipoDoc: preview.proveedor.tipoDoc,
      clienteNumDoc: preview.proveedor.numDoc,
      clienteRazonSocial: preview.proveedor.rznSocial,
      moneda: 'PEN',
      montoTotal: tipo === '20'
        ? (preview as RetentionInput).impRetenido
        : (preview as PerceptionInput).impPercibido,
        state: 'PENDIENTE',
        payload: input,
      });

  const doc = prepararRetPer(tenant, input, Number(row.correlativo));
  const fileName = nombreCpe(tenant.ruc, tipo, doc.serie, doc.correlativo);
  const signed = signUbl(xmlRetPer(tipo, doc), secrets.certificate.privateKeyPem, secrets.certificate.certificatePem);
  const fecha = isoDate(doc.fechaEmision);

  const xmlPath = await storage.put(
    artifactKey(tenant.ruc, fecha, fileName, 'xml'),
    Buffer.from(signed.xml, 'utf8'),
    'application/xml',
  );
  await repo.actualizarDocumento(row.id, { xmlPath, digestValue: signed.digestValue, state: 'EN_COLA_SUNAT' });

  const paths: EmisionResult['paths'] = { xml: xmlPath };
  const base: EmisionResult = {
    documentId: row.id, fileName, xml: signed.xml, hash: signed.digestValue,
    state: 'EN_COLA_SUNAT', paths,
  };

  const guardarPdfRetPer = async (observacion?: string) => {
    if (options.generarPdf === false) return;
    try {
      const pdf = await renderRetPerPdf(tipo, normalizar(tipo, doc), signed.digestValue);
      void observacion;
      paths.pdf = await storage.put(artifactKey(tenant.ruc, fecha, fileName, 'pdf'), pdf, 'application/pdf');
      await repo.actualizarDocumento(row.id, { pdfPath: paths.pdf });
    } catch (err) {
      await repo.actualizarDocumento(row.id, { lastError: `PDF: ${(err as Error).message}` });
    }
  };

  let cdr: CdrResponse;
  try {
    // 'otros' = ol-ti-itemision-otroscpe-gem, el servicio de retenciones/percepciones.
    const result = await soapClient(tenant, secrets).sendBill(fileName, await zipXml(fileName, signed.xml), 'otros');
    cdr = result.cdr;
    paths.cdr = await storage.put(
      artifactKey(tenant.ruc, fecha, `R-${fileName}`, 'zip'),
      result.cdrZip,
      'application/zip',
    );
  } catch (err) {
    const isSunat = err instanceof SunatError;
    const state: repo.SunatState = isSunat && !err.retryable ? 'RECHAZADO' : 'EXCEPCION';
    await repo.actualizarDocumento(row.id, {
      state,
      code: isSunat ? err.code : null,
      description: (err as Error).message,
      lastError: (err as Error).message,
      incrementRetry: true,
    });
    await guardarPdfRetPer();
    return { ...base, state, error: (err as Error).message };
  }

  const state = clienteState(cdr);
  await repo.actualizarDocumento(row.id, {
    state,
    code: cdr.code,
    description: cdr.description,
    notes: cdr.notes.length ? cdr.notes : null,
    cdrPath: paths.cdr ?? null,
  });
  await guardarPdfRetPer(cdr.description);

  return { ...base, state, cdr };
}
