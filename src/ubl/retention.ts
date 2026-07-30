import { create } from 'xmlbuilder2';
import { NS } from './namespaces.ts';
import { addSignature, addUblExtensions, cac, cbc, cbcCdata, sac } from './common.ts';
import type { CompanyInput, PerceptionInput, RetentionInput } from '../domain/schemas.ts';
import { fmt } from '../util/money.ts';
import { isoDate, isoTime } from '../util/dates.ts';

export type RetentionDoc = Omit<RetentionInput, 'company'> & {
  company: CompanyInput;
  correlativo: string;
  fechaEmision: string;
};

export type PerceptionDoc = Omit<PerceptionInput, 'company'> & {
  company: CompanyInput;
  correlativo: string;
  fechaEmision: string;
};

/**
 * Retención y Percepción comparten estructura: sólo cambian el elemento raíz
 * y los nombres de los tags propios de SUNAT (sac:*).
 */
interface Layout {
  root: string;
  namespace: string;
  /** Elemento del emisor: el XSD de SUNAT exige cac:AgentParty en ambos. */
  agentTag: string;
  systemCode: string;
  percent: string;
  totalTag: string;
  docRef: string;
  info: string;
  amount: string;
  date: string;
  netTotal: string;
}

const RETENCION: Layout = {
  root: 'Retention',
  namespace: 'urn:sunat:names:specification:ubl:peru:schema:xsd:Retention-1',
  agentTag: 'AgentParty',
  systemCode: 'SUNATRetentionSystemCode',
  percent: 'SUNATRetentionPercent',
  totalTag: 'SUNATTotalPaid',
  docRef: 'SUNATRetentionDocumentReference',
  info: 'SUNATRetentionInformation',
  amount: 'SUNATRetentionAmount',
  date: 'SUNATRetentionDate',
  netTotal: 'SUNATNetTotalPaid',
};

const PERCEPCION: Layout = {
  root: 'Perception',
  namespace: 'urn:sunat:names:specification:ubl:peru:schema:xsd:Perception-1',
  agentTag: 'AgentParty',
  systemCode: 'SUNATPerceptionSystemCode',
  percent: 'SUNATPerceptionPercent',
  totalTag: 'SUNATTotalCashed',
  docRef: 'SUNATPerceptionDocumentReference',
  info: 'SUNATPerceptionInformation',
  amount: 'SUNATPerceptionAmount',
  date: 'SUNATPerceptionDate',
  netTotal: 'SUNATNetTotalCashed',
};

interface Linea {
  tipoDoc: string;
  numDoc: string;
  fechaEmision: string;
  moneda: string;
  impTotal: number;
  pagos?: Array<{ moneda: string; importe: number; fecha: string }>;
  fecha: string;
  importe: number;
  neto: number;
  tipoCambio?: { monedaRef: string; monedaObj: string; factor: number; fecha: string };
}

interface Comun {
  company: CompanyInput;
  serie: string;
  correlativo: string;
  fechaEmision: string;
  proveedor: RetentionDoc['proveedor'];
  regimen: string;
  tasa: number;
  observacion?: string;
  /** Total retenido o percibido. */
  total: number;
  /** Total pagado (retención) o cobrado (percepción). */
  totalNeto: number;
  details: Linea[];
}

function build(l: Layout, doc: Comun): string {
  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele(l.namespace, l.root)
    .att('xmlns:cac', NS.cac)
    .att('xmlns:cbc', NS.cbc)
    .att('xmlns:ds', NS.ds)
    .att('xmlns:ext', NS.ext)
    .att('xmlns:sac', NS.sac);

  addUblExtensions(root);
  cbc(root, 'UBLVersionID', '2.0');
  cbc(root, 'CustomizationID', '1.0');
  // En estos comprobantes la firma va antes del ID (así lo exige el XSD).
  addSignature(root, doc.company);
  cbc(root, 'ID', `${doc.serie}-${doc.correlativo}`);
  cbc(root, 'IssueDate', isoDate(doc.fechaEmision));
  cbc(root, 'IssueTime', isoTime(doc.fechaEmision));

  const agente = cac(root, l.agentTag);
  cbc(cac(agente, 'PartyIdentification'), 'ID', doc.company.ruc, { schemeID: '6' });
  if (doc.company.nombreComercial) cbcCdata(cac(agente, 'PartyName'), 'Name', doc.company.nombreComercial);
  const addr = doc.company.address;
  if (addr) {
    const postal = cac(agente, 'PostalAddress');
    if (addr.ubigueo) cbc(postal, 'ID', addr.ubigueo);
    cbcCdata(postal, 'StreetName', addr.direccion ?? '-');
    cbc(postal, 'CityName', addr.departamento ?? '');
    cbc(postal, 'CountrySubentity', addr.provincia ?? '');
    cbc(postal, 'District', addr.distrito ?? '');
    cbc(cac(postal, 'Country'), 'IdentificationCode', addr.codigoPais || 'PE');
  }
  cbcCdata(cac(agente, 'PartyLegalEntity'), 'RegistrationName', doc.company.razonSocial);

  const receptor = cac(root, 'ReceiverParty');
  cbc(cac(receptor, 'PartyIdentification'), 'ID', doc.proveedor.numDoc, { schemeID: doc.proveedor.tipoDoc });
  cbcCdata(cac(receptor, 'PartyLegalEntity'), 'RegistrationName', doc.proveedor.rznSocial);

  sac(root, l.systemCode).txt(doc.regimen);
  sac(root, l.percent).txt(fmt(doc.tasa));
  if (doc.observacion) cbcCdata(root, 'Note', doc.observacion);
  cbc(root, 'TotalInvoiceAmount', fmt(doc.total), { currencyID: 'PEN' });
  sac(root, l.totalTag).att('currencyID', 'PEN').txt(fmt(doc.totalNeto));

  for (const det of doc.details) {
    const ref = sac(root, l.docRef);
    cbc(ref, 'ID', det.numDoc, { schemeID: det.tipoDoc });
    cbc(ref, 'IssueDate', isoDate(det.fechaEmision));
    cbc(ref, 'TotalInvoiceAmount', fmt(det.impTotal), { currencyID: det.moneda });

    (det.pagos ?? []).forEach((pago, i) => {
      const node = cac(ref, 'Payment');
      cbc(node, 'ID', String(i + 1));
      cbc(node, 'PaidAmount', fmt(pago.importe), { currencyID: pago.moneda });
      cbc(node, 'PaidDate', isoDate(pago.fecha));
    });

    const info = sac(ref, l.info);
    sac(info, l.amount).att('currencyID', 'PEN').txt(fmt(det.importe));
    sac(info, l.date).txt(isoDate(det.fecha));
    sac(info, l.netTotal).att('currencyID', 'PEN').txt(fmt(det.neto));
    if (det.tipoCambio) {
      const tc = cac(info, 'ExchangeRate');
      cbc(tc, 'SourceCurrencyCode', det.tipoCambio.monedaRef);
      cbc(tc, 'TargetCurrencyCode', det.tipoCambio.monedaObj);
      cbc(tc, 'CalculationRate', fmt(det.tipoCambio.factor, 6));
      cbc(tc, 'Date', isoDate(det.tipoCambio.fecha));
    }
  }

  return root.end({ prettyPrint: false });
}

/** Comprobante de Retención (tipo 20). */
export function buildRetentionXml(doc: RetentionDoc): string {
  return build(RETENCION, {
    ...doc,
    total: doc.impRetenido,
    totalNeto: doc.impPagado,
    details: doc.details.map((d) => ({
      tipoDoc: d.tipoDoc,
      numDoc: d.numDoc,
      fechaEmision: d.fechaEmision,
      moneda: d.moneda,
      impTotal: d.impTotal,
      pagos: d.pagos,
      fecha: d.fechaRetencion,
      importe: d.impRetenido,
      neto: d.impPagar,
      tipoCambio: d.tipoCambio,
    })),
  });
}

/** Comprobante de Percepción (tipo 40). */
export function buildPerceptionXml(doc: PerceptionDoc): string {
  return build(PERCEPCION, {
    ...doc,
    total: doc.impPercibido,
    totalNeto: doc.impCobrado,
    details: doc.details.map((d) => ({
      tipoDoc: d.tipoDoc,
      numDoc: d.numDoc,
      fechaEmision: d.fechaEmision,
      moneda: d.moneda,
      impTotal: d.impTotal,
      pagos: d.cobros,
      fecha: d.fechaPercepcion,
      importe: d.impPercibido,
      neto: d.impCobrar,
      tipoCambio: d.tipoCambio,
    })),
  });
}

/** Vista unificada para el PDF y el almacenamiento. */
export function normalizar(tipo: '20' | '40', doc: RetentionDoc | PerceptionDoc): Comun {
  return tipo === '20'
    ? {
        ...(doc as RetentionDoc),
        total: (doc as RetentionDoc).impRetenido,
        totalNeto: (doc as RetentionDoc).impPagado,
        details: (doc as RetentionDoc).details.map((d) => ({
          tipoDoc: d.tipoDoc, numDoc: d.numDoc, fechaEmision: d.fechaEmision, moneda: d.moneda,
          impTotal: d.impTotal, pagos: d.pagos, fecha: d.fechaRetencion, importe: d.impRetenido,
          neto: d.impPagar, tipoCambio: d.tipoCambio,
        })),
      }
    : {
        ...(doc as PerceptionDoc),
        total: (doc as PerceptionDoc).impPercibido,
        totalNeto: (doc as PerceptionDoc).impCobrado,
        details: (doc as PerceptionDoc).details.map((d) => ({
          tipoDoc: d.tipoDoc, numDoc: d.numDoc, fechaEmision: d.fechaEmision, moneda: d.moneda,
          impTotal: d.impTotal, pagos: d.cobros, fecha: d.fechaPercepcion, importe: d.impPercibido,
          neto: d.impCobrar, tipoCambio: d.tipoCambio,
        })),
      };
}

export type ComprobanteRetPer = Comun;
