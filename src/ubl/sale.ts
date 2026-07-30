import { create } from 'xmlbuilder2';
import type { XB as XMLBuilder } from './xb.ts';
import { NS } from './namespaces.ts';
import { addPersonParty, addSignature, addSupplierParty, addTaxSubtotal, addUblExtensions, cac, cbc, cbcCdata } from './common.ts';
import {
  TRIBUTO_EXONERADO, TRIBUTO_EXPORTACION, TRIBUTO_GRATUITO, TRIBUTO_ICBPER, TRIBUTO_IGV,
  TRIBUTO_INAFECTO, TRIBUTO_ISC, TRIBUTO_IVAP, TRIBUTO_OTROS, tributoDe,
} from '../domain/catalogs.ts';
import type { ChargeLike, SaleDoc } from './types.ts';
import { fmt, fmtLimit } from '../util/money.ts';
import { isoDate, isoTime } from '../util/dates.ts';

interface Layout {
  rootName: string;
  namespace: string;
  lineName: string;
  quantityName: string;
  totalsName: string;
  isNote: boolean;
}

function layoutFor(tipoDoc: string): Layout {
  switch (tipoDoc) {
    case '07':
      return { rootName: 'CreditNote', namespace: NS.creditNote, lineName: 'CreditNoteLine', quantityName: 'CreditedQuantity', totalsName: 'LegalMonetaryTotal', isNote: true };
    case '08':
      return { rootName: 'DebitNote', namespace: NS.debitNote, lineName: 'DebitNoteLine', quantityName: 'DebitedQuantity', totalsName: 'RequestedMonetaryTotal', isNote: true };
    default:
      return { rootName: 'Invoice', namespace: NS.invoice, lineName: 'InvoiceLine', quantityName: 'InvoicedQuantity', totalsName: 'LegalMonetaryTotal', isNote: false };
  }
}

/**
 * Construye el XML UBL 2.1 de una Factura (01), Boleta (03),
 * Nota de Crédito (07) o Nota de Débito (08).
 */
export function buildSaleXml(doc: SaleDoc): string {
  const l = layoutFor(doc.tipoDoc);
  const cur = doc.tipoMoneda;

  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele(l.namespace, l.rootName)
    .att('xmlns:cac', NS.cac)
    .att('xmlns:cbc', NS.cbc)
    .att('xmlns:ds', NS.ds)
    .att('xmlns:ext', NS.ext);

  addUblExtensions(root);
  cbc(root, 'UBLVersionID', '2.1');
  cbc(root, 'CustomizationID', '2.0');
  cbc(root, 'ID', `${doc.serie}-${doc.correlativo}`);
  cbc(root, 'IssueDate', isoDate(doc.fechaEmision));
  cbc(root, 'IssueTime', isoTime(doc.fechaEmision));
  if (!l.isNote && doc.fecVencimiento) cbc(root, 'DueDate', isoDate(doc.fecVencimiento));
  if (!l.isNote) cbc(root, 'InvoiceTypeCode', doc.tipoDoc, { listID: doc.tipoOperacion ?? '0101' });

  for (const leg of doc.legends ?? []) cbcCdata(root, 'Note', leg.value, { languageLocaleID: leg.code });
  if (doc.observacion) cbcCdata(root, 'Note', doc.observacion);
  cbc(root, 'DocumentCurrencyCode', cur);

  if (l.isNote) {
    const disc = cac(root, 'DiscrepancyResponse');
    cbc(disc, 'ReferenceID', doc.numDocfectado ?? '');
    cbc(disc, 'ResponseCode', doc.codMotivo ?? '');
    cbcCdata(disc, 'Description', doc.desMotivo ?? '');
  }

  if (doc.compra) cbc(cac(root, 'OrderReference'), 'ID', doc.compra);

  if (l.isNote) {
    const ref = cac(cac(root, 'BillingReference'), 'InvoiceDocumentReference');
    cbc(ref, 'ID', doc.numDocfectado ?? '');
    cbc(ref, 'DocumentTypeCode', doc.tipDocAfectado ?? '');
  }

  for (const guia of doc.guias ?? []) {
    const node = cac(root, 'DespatchDocumentReference');
    cbc(node, 'ID', guia.nroDoc);
    cbc(node, 'DocumentTypeCode', guia.tipoDoc);
  }
  for (const rel of doc.relDocs ?? []) {
    const node = cac(root, 'AdditionalDocumentReference');
    cbc(node, 'ID', rel.nroDoc);
    cbc(node, 'DocumentTypeCode', rel.tipoDoc);
  }
  // Anticipos: se referencian como documentos adicionales del propio emisor.
  (doc.anticipos ?? []).forEach((ant, i) => {
    const node = cac(root, 'AdditionalDocumentReference');
    cbc(node, 'ID', ant.nroDocRel);
    cbc(node, 'DocumentTypeCode', ant.tipoDocRel);
    cbc(node, 'DocumentStatusCode', String(i + 1));
    const issuer = cac(node, 'IssuerParty');
    cbc(cac(issuer, 'PartyIdentification'), 'ID', doc.company.ruc, { schemeID: '6' });
  });

  addSignature(root, doc.company);
  addSupplierParty(root, doc.company);
  addPersonParty(root, 'AccountingCustomerParty', doc.client);
  if (doc.seller) addPersonParty(root, 'SellerSupplierParty', doc.seller);

  if (doc.direccionEntrega) {
    const addr = doc.direccionEntrega;
    const node = cac(cac(cac(root, 'Delivery'), 'DeliveryLocation'), 'Address');
    if (addr.ubigueo) cbc(node, 'ID', addr.ubigueo);
    if (addr.urbanizacion) cbc(node, 'CitySubdivisionName', addr.urbanizacion);
    cbc(node, 'CityName', addr.provincia ?? '');
    cbc(node, 'CountrySubentity', addr.departamento ?? '');
    cbc(node, 'District', addr.distrito ?? '');
    cbcCdata(cac(node, 'AddressLine'), 'Line', addr.direccion ?? '-');
    cbc(cac(node, 'Country'), 'IdentificationCode', addr.codigoPais || 'PE');
  }

  if (doc.detraccion) {
    const d = doc.detraccion;
    const means = cac(root, 'PaymentMeans');
    cbc(means, 'ID', 'Detraccion');
    cbc(means, 'PaymentMeansCode', d.codMedioPago);
    cbc(cac(means, 'PayeeFinancialAccount'), 'ID', d.ctaBanco);
    const terms = cac(root, 'PaymentTerms');
    cbc(terms, 'ID', 'Detraccion');
    cbc(terms, 'PaymentMeansID', d.codBienDetraccion);
    cbc(terms, 'PaymentPercent', fmt(d.percent));
    cbc(terms, 'Amount', fmt(d.mount), { currencyID: 'PEN' });
  }

  if (doc.perception) {
    const terms = cac(root, 'PaymentTerms');
    cbc(terms, 'ID', 'Percepcion');
    cbc(terms, 'Amount', fmt(doc.perception.mtoTotal), { currencyID: 'PEN' });
  }

  if (doc.formaPago) {
    const terms = cac(root, 'PaymentTerms');
    cbc(terms, 'ID', 'FormaPago');
    cbc(terms, 'PaymentMeansID', doc.formaPago.tipo);
    if (doc.formaPago.monto !== undefined) {
      cbc(terms, 'Amount', fmt(doc.formaPago.monto), { currencyID: doc.formaPago.moneda || cur });
    }
  }
  (doc.cuotas ?? []).forEach((c, i) => {
    const terms = cac(root, 'PaymentTerms');
    cbc(terms, 'ID', 'FormaPago');
    cbc(terms, 'PaymentMeansID', `Cuota${String(i + 1).padStart(3, '0')}`);
    cbc(terms, 'Amount', fmt(c.monto), { currencyID: c.moneda || cur });
    cbc(terms, 'PaymentDueDate', isoDate(c.fechaPago));
  });

  (doc.anticipos ?? []).forEach((ant, i) => {
    const node = cac(root, 'PrepaidPayment');
    cbc(node, 'ID', String(i + 1));
    cbc(node, 'PaidAmount', fmt(ant.total), { currencyID: ant.moneda || cur });
  });

  for (const cargo of doc.cargos ?? []) addAllowanceCharge(root, cargo, true, cur);
  for (const desc of doc.descuentos ?? []) addAllowanceCharge(root, desc, false, cur);
  if (doc.perception) {
    const p = doc.perception;
    const node = cac(root, 'AllowanceCharge');
    cbc(node, 'ChargeIndicator', 'true');
    cbc(node, 'AllowanceChargeReasonCode', p.codReg);
    // `porcentaje` ya es el factor de la percepción (0.02 = 2 %): SUNAT valida
    // que factor x base = monto y rechaza con 2798 si no coincide.
    cbc(node, 'MultiplierFactorNumeric', fmtLimit(p.porcentaje, 5));
    cbc(node, 'Amount', fmt(p.mto), { currencyID: 'PEN' });
    cbc(node, 'BaseAmount', fmt(p.mtoBase), { currencyID: 'PEN' });
  }

  addDocumentTaxTotal(root, doc);
  addMonetaryTotals(root, doc, l);
  doc.details.forEach((detail, i) => addLine(root, doc, detail, i + 1, l));

  return root.end({ prettyPrint: false });
}

function addAllowanceCharge(root: XMLBuilder, charge: ChargeLike, isCharge: boolean, cur: string): void {
  const node = cac(root, 'AllowanceCharge');
  cbc(node, 'ChargeIndicator', isCharge ? 'true' : 'false');
  cbc(node, 'AllowanceChargeReasonCode', charge.codTipo);
  if (charge.factor !== undefined) cbc(node, 'MultiplierFactorNumeric', fmtLimit(charge.factor, 5));
  cbc(node, 'Amount', fmt(charge.monto), { currencyID: cur });
  if (charge.montoBase !== undefined) cbc(node, 'BaseAmount', fmt(charge.montoBase), { currencyID: cur });
}

function addDocumentTaxTotal(root: XMLBuilder, doc: SaleDoc): void {
  const cur = doc.tipoMoneda;
  const taxTotal = cac(root, 'TaxTotal');
  cbc(taxTotal, 'TaxAmount', fmt(doc.totalImpuestos ?? 0), { currencyID: cur });

  if (doc.mtoISC) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoBaseIsc ?? 0, taxAmount: doc.mtoISC, tributo: TRIBUTO_ISC, currency: cur });
  }
  if (doc.mtoOperGravadas !== undefined) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoOperGravadas, taxAmount: doc.mtoIGV ?? 0, tributo: TRIBUTO_IGV, currency: cur });
  }
  if (doc.mtoOperInafectas !== undefined) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoOperInafectas, taxAmount: 0, tributo: TRIBUTO_INAFECTO, currency: cur });
  }
  if (doc.mtoOperExoneradas !== undefined) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoOperExoneradas, taxAmount: 0, tributo: TRIBUTO_EXONERADO, currency: cur });
  }
  if (doc.mtoOperGratuitas !== undefined) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoOperGratuitas, taxAmount: doc.mtoIGVGratuitas ?? 0, tributo: TRIBUTO_GRATUITO, currency: cur });
  }
  if (doc.mtoOperExportacion !== undefined) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoOperExportacion, taxAmount: 0, tributo: TRIBUTO_EXPORTACION, currency: cur });
  }
  if (doc.mtoIvap) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoBaseIvap ?? 0, taxAmount: doc.mtoIvap, tributo: TRIBUTO_IVAP, currency: cur });
  }
  if (doc.mtoOtrosTributos) {
    addTaxSubtotal(taxTotal, { taxableAmount: doc.mtoBaseOth ?? 0, taxAmount: doc.mtoOtrosTributos, tributo: TRIBUTO_OTROS, currency: cur });
  }
  if (doc.icbper) {
    addTaxSubtotal(taxTotal, { taxAmount: doc.icbper, tributo: TRIBUTO_ICBPER, currency: cur });
  }
}

function addMonetaryTotals(root: XMLBuilder, doc: SaleDoc, l: Layout): void {
  const cur = doc.tipoMoneda;
  const totals = cac(root, l.totalsName);
  // La Nota de Crédito sólo declara el importe total (regla SUNAT 2.1).
  const includeLineTotals = !(doc.tipoDoc === '07');
  if (includeLineTotals) {
    if (doc.valorVenta !== undefined) cbc(totals, 'LineExtensionAmount', fmt(doc.valorVenta), { currencyID: cur });
    if (doc.subTotal !== undefined) cbc(totals, 'TaxInclusiveAmount', fmt(doc.subTotal), { currencyID: cur });
  }
  if (!l.isNote && doc.sumOtrosDescuentos !== undefined) {
    cbc(totals, 'AllowanceTotalAmount', fmt(doc.sumOtrosDescuentos), { currencyID: cur });
  }
  if (doc.sumOtrosCargos !== undefined) cbc(totals, 'ChargeTotalAmount', fmt(doc.sumOtrosCargos), { currencyID: cur });
  if (!l.isNote && doc.totalAnticipos !== undefined) {
    cbc(totals, 'PrepaidAmount', fmt(doc.totalAnticipos), { currencyID: cur });
  }
  if (doc.redondeo !== undefined) cbc(totals, 'PayableRoundingAmount', fmt(doc.redondeo), { currencyID: cur });
  cbc(totals, 'PayableAmount', fmt(doc.mtoImpVenta ?? 0), { currencyID: cur });
}

function addLine(root: XMLBuilder, doc: SaleDoc, d: SaleDoc['details'][number], index: number, l: Layout): void {
  const cur = doc.tipoMoneda;
  const line = cac(root, l.lineName);
  cbc(line, 'ID', String(index));
  cbc(line, l.quantityName, fmtLimit(d.cantidad, 10), { unitCode: d.unidad });
  cbc(line, 'LineExtensionAmount', fmt(d.mtoValorVenta ?? 0), { currencyID: cur });

  const pricing = cac(line, 'PricingReference');
  const alt = cac(pricing, 'AlternativeConditionPrice');
  if (d.mtoValorGratuito) {
    cbc(alt, 'PriceAmount', fmtLimit(d.mtoValorGratuito, 10), { currencyID: cur });
    cbc(alt, 'PriceTypeCode', '02');
  } else {
    cbc(alt, 'PriceAmount', fmtLimit(d.mtoPrecioUnitario ?? 0, 10), { currencyID: cur });
    cbc(alt, 'PriceTypeCode', '01');
  }

  for (const cargo of d.cargos ?? []) addAllowanceCharge(line, cargo, true, cur);
  for (const desc of d.descuentos ?? []) addAllowanceCharge(line, desc, false, cur);

  const taxTotal = cac(line, 'TaxTotal');
  cbc(taxTotal, 'TaxAmount', fmt(d.totalImpuestos ?? 0), { currencyID: cur });
  if (d.isc) {
    addTaxSubtotal(taxTotal, {
      taxableAmount: d.mtoBaseIsc ?? 0, taxAmount: d.isc, tributo: TRIBUTO_ISC, currency: cur,
      percent: d.porcentajeIsc ?? 0, tierRange: d.tipSisIsc ?? '01',
    });
  }
  addTaxSubtotal(taxTotal, {
    taxableAmount: d.mtoBaseIgv ?? 0, taxAmount: d.igv ?? 0, tributo: tributoDe(d.tipAfeIgv), currency: cur,
    percent: d.porcentajeIgv, exemptionReasonCode: d.tipAfeIgv,
  });
  if (d.otroTributo) {
    addTaxSubtotal(taxTotal, {
      taxableAmount: d.mtoBaseOth ?? 0, taxAmount: d.otroTributo, tributo: TRIBUTO_OTROS, currency: cur,
      percent: d.porcentajeOth ?? 0,
    });
  }
  if (d.icbper) {
    addTaxSubtotal(taxTotal, {
      taxAmount: d.icbper, tributo: TRIBUTO_ICBPER, currency: cur,
      perUnitAmount: d.factorIcbper ?? 0,
      baseUnitMeasure: { value: d.cantidad, unitCode: 'NIU' },
    });
  }

  const item = cac(line, 'Item');
  cbcCdata(item, 'Description', d.descripcion);
  if (d.codProducto) cbc(cac(item, 'SellersItemIdentification'), 'ID', d.codProducto);
  if (d.codProdGS1) cbc(cac(item, 'StandardItemIdentification'), 'ID', d.codProdGS1);
  if (d.codProdSunat) cbc(cac(item, 'CommodityClassification'), 'ItemClassificationCode', d.codProdSunat);
  for (const atr of d.atributos ?? []) {
    const prop = cac(item, 'AdditionalItemProperty');
    cbc(prop, 'Name', atr.name);
    cbc(prop, 'NameCode', atr.code);
    if (atr.value !== undefined) cbc(prop, 'Value', atr.value);
    if (atr.fecInicio || atr.fecFin || atr.duracion !== undefined) {
      const period = cac(prop, 'UsabilityPeriod');
      if (atr.fecInicio) cbc(period, 'StartDate', isoDate(atr.fecInicio));
      if (atr.fecFin) cbc(period, 'EndDate', isoDate(atr.fecFin));
      if (atr.duracion !== undefined) cbc(period, 'DurationMeasure', atr.duracion, { unitCode: 'DAY' });
    }
  }

  cbc(cac(line, 'Price'), 'PriceAmount', fmtLimit(d.mtoValorUnitario ?? 0, 10), { currencyID: cur });
}
