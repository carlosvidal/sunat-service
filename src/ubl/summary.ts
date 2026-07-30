import { create } from 'xmlbuilder2';
import type { XB } from './xb.ts';
import { NS } from './namespaces.ts';
import { addSignature, addTaxSubtotal, addUblExtensions, cac, cbc, cbcCdata, sac } from './common.ts';
import { TRIBUTO_ICBPER, TRIBUTO_IGV, TRIBUTO_ISC, TRIBUTO_IVAP, TRIBUTO_OTROS } from '../domain/catalogs.ts';
import type { SummaryDoc, VoidedDoc } from './types.ts';
import { fmt } from '../util/money.ts';
import { isoDate } from '../util/dates.ts';
import type { CompanyInput } from '../domain/schemas.ts';

/** cac:AccountingSupplierParty en su variante reducida (RC y RA). */
function addSummarySupplier(root: XB, company: CompanyInput): void {
  const supplier = cac(root, 'AccountingSupplierParty');
  cbc(supplier, 'CustomerAssignedAccountID', company.ruc);
  cbc(supplier, 'AdditionalAccountID', '6');
  const legal = cac(cac(supplier, 'Party'), 'PartyLegalEntity');
  cbcCdata(legal, 'RegistrationName', company.razonSocial);
}

/** Resumen Diario de Boletas (RC) — UBL SummaryDocuments 1.1. */
export function buildSummaryXml(doc: SummaryDoc): string {
  const cur = doc.moneda;
  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele(NS.summary, 'SummaryDocuments')
    .att('xmlns:cac', NS.cac)
    .att('xmlns:cbc', NS.cbc)
    .att('xmlns:ds', NS.ds)
    .att('xmlns:ext', NS.ext)
    .att('xmlns:sac', NS.sac);

  addUblExtensions(root);
  cbc(root, 'UBLVersionID', '2.0');
  cbc(root, 'CustomizationID', '1.1');
  cbc(root, 'ID', doc.xmlId);
  // ReferenceDate = día de las boletas resumidas; IssueDate = día del envío.
  cbc(root, 'ReferenceDate', isoDate(doc.fecGeneracion));
  cbc(root, 'IssueDate', isoDate(doc.fecResumen ?? doc.fecGeneracion));
  addSignature(root, doc.company);
  addSummarySupplier(root, doc.company);

  doc.details.forEach((det, i) => {
    const line = sac(root, 'SummaryDocumentsLine');
    cbc(line, 'LineID', String(i + 1));
    cbc(line, 'DocumentTypeCode', det.tipoDoc);
    cbc(line, 'ID', det.serieNro);

    const customer = cac(line, 'AccountingCustomerParty');
    cbc(customer, 'CustomerAssignedAccountID', det.clienteNro ?? '');
    cbc(customer, 'AdditionalAccountID', det.clienteTipo ?? '');

    if (det.docReferencia) {
      const ref = cac(cac(line, 'BillingReference'), 'InvoiceDocumentReference');
      cbc(ref, 'ID', det.docReferencia.nroDoc);
      cbc(ref, 'DocumentTypeCode', det.docReferencia.tipoDoc);
    }

    if (det.percepcion) {
      const p = det.percepcion;
      const node = sac(line, 'SUNATPerceptionSummaryDocumentReference');
      sac(node, 'SUNATPerceptionSystemCode').txt(p.codReg);
      sac(node, 'SUNATPerceptionPercent').txt(fmt(p.tasa));
      cbc(node, 'TotalInvoiceAmount', fmt(p.mto), { currencyID: 'PEN' });
      sac(node, 'SUNATTotalCashed').att('currencyID', 'PEN').txt(fmt(p.mtoTotal));
      cbc(node, 'TaxableAmount', fmt(p.mtoBase), { currencyID: 'PEN' });
    }

    cbc(cac(line, 'Status'), 'ConditionCode', det.estado);
    sac(line, 'TotalAmount').att('currencyID', cur).txt(fmt(det.total));

    const pagos: Array<[number | undefined, string]> = [
      [det.mtoOperGravadas, '01'],
      [det.mtoOperExoneradas, '02'],
      [det.mtoOperInafectas, '03'],
      [det.mtoOperExportacion, '04'],
      [det.mtoOperGratuitas, '05'],
    ];
    for (const [monto, instruction] of pagos) {
      if (monto === undefined) continue;
      if (instruction !== '01' && !monto) continue;
      const bp = sac(line, 'BillingPayment');
      cbc(bp, 'PaidAmount', fmt(monto), { currencyID: cur });
      cbc(bp, 'InstructionID', instruction);
    }

    if (det.mtoOtrosCargos) {
      const ac = cac(line, 'AllowanceCharge');
      cbc(ac, 'ChargeIndicator', 'true');
      cbc(ac, 'Amount', fmt(det.mtoOtrosCargos), { currencyID: cur });
    }

    // Cada tributo va en su propio cac:TaxTotal (estructura del RC).
    if (det.mtoIvap) {
      addSummaryTax(line, det.mtoIvap, cur, TRIBUTO_IVAP);
    } else {
      addSummaryTax(line, det.mtoIGV ?? 0, cur, TRIBUTO_IGV, det.porcentajeIgv);
    }
    if (det.mtoISC) addSummaryTax(line, det.mtoISC, cur, TRIBUTO_ISC);
    if (det.mtoOtrosTributos) addSummaryTax(line, det.mtoOtrosTributos, cur, TRIBUTO_OTROS);
    if (det.mtoIcbper) addSummaryTax(line, det.mtoIcbper, cur, TRIBUTO_ICBPER);
  });

  return root.end({ prettyPrint: false });
}

function addSummaryTax(line: XB, monto: number, cur: string, tributo: { id: string; name: string; code: string }, percent?: number): void {
  const taxTotal = cac(line, 'TaxTotal');
  cbc(taxTotal, 'TaxAmount', fmt(monto), { currencyID: cur });
  addTaxSubtotal(taxTotal, { taxAmount: monto, tributo, currency: cur, percent });
}

/** Comunicación de Baja (RA) — UBL VoidedDocuments 1.0. */
export function buildVoidedXml(doc: VoidedDoc): string {
  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele(NS.voided, 'VoidedDocuments')
    .att('xmlns:cac', NS.cac)
    .att('xmlns:cbc', NS.cbc)
    .att('xmlns:ds', NS.ds)
    .att('xmlns:ext', NS.ext)
    .att('xmlns:sac', NS.sac);

  addUblExtensions(root);
  cbc(root, 'UBLVersionID', '2.0');
  cbc(root, 'CustomizationID', '1.0');
  cbc(root, 'ID', doc.xmlId);
  cbc(root, 'ReferenceDate', isoDate(doc.fecGeneracion));
  cbc(root, 'IssueDate', isoDate(doc.fecComunicacion ?? doc.fecGeneracion));
  addSignature(root, doc.company);
  addSummarySupplier(root, doc.company);

  doc.details.forEach((det, i) => {
    const line = sac(root, 'VoidedDocumentsLine');
    cbc(line, 'LineID', String(i + 1));
    cbc(line, 'DocumentTypeCode', det.tipoDoc);
    sac(line, 'DocumentSerialID').txt(det.serie);
    sac(line, 'DocumentNumberID').txt(det.correlativo);
    sac(line, 'VoidReasonDescription').dat(det.desMotivoBaja);
  });

  return root.end({ prettyPrint: false });
}
