import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmt, fmtLimit, round } from '../src/util/money.ts';
import { numeroALetras } from '../src/util/numero-letras.ts';
import { isoDate, isoTime } from '../src/util/dates.ts';
import { invoiceSchema, noteSchema } from '../src/domain/schemas.ts';
import { completarTotales, validarTotales } from '../src/domain/totals.ts';
import { afectacionDe, tributoDe } from '../src/domain/catalogs.ts';
import { buildSaleXml } from '../src/ubl/sale.ts';
import { buildSummaryXml, buildVoidedXml } from '../src/ubl/summary.ts';
import { signUbl } from '../src/ubl/sign.ts';
import { generateSelfSignedPfx, loadCertificate } from '../src/security/certificate.ts';
import { LocalAesVault } from '../src/security/secrets.ts';
import { parseCdrXml } from '../src/sunat/cdr.ts';
import { clasificar, esReintentable } from '../src/sunat/errors.ts';
import { qrText } from '../src/services/qr.ts';
import { nombreResumen } from '../src/services/naming.ts';
import type { SaleDoc } from '../src/ubl/types.ts';

const company = {
  ruc: '20000000001',
  razonSocial: 'MI TIENDA S.A.C.',
  nombreComercial: 'MI EMPRESA',
  address: {
    ubigueo: '150101', codLocal: '0000', codigoPais: 'PE',
    direccion: 'AV. EMISOR 456', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA',
  },
};

const clientData = {
  tipoDoc: '6', numDoc: '20000000002', rznSocial: 'CLIENTE DEMO S.A.C.',
  address: { direccion: 'AV. CLIENTE 123', codigoPais: 'PE', codLocal: '0000' },
};

function facturaBase(overrides: Record<string, unknown> = {}) {
  return invoiceSchema.parse({
    tipoDoc: '01', serie: 'F001', correlativo: '1',
    fechaEmision: '2026-07-29T10:30:00-05:00',
    tipoMoneda: 'PEN', client: clientData, company,
    details: [{ codProducto: 'P1', unidad: 'NIU', descripcion: 'PRODUCTO 1', cantidad: 2, mtoValorUnitario: 100 }],
    ...overrides,
  });
}

function toDoc(parsed: ReturnType<typeof facturaBase>): SaleDoc {
  return { ...completarTotales(parsed), company, correlativo: '1', fechaEmision: parsed.fechaEmision! } as SaleDoc;
}

test('money: redondeo y formato', () => {
  assert.equal(round(1.005), 1.01);
  assert.equal(round(0.615), 0.62);
  assert.equal(fmt(36), '36.00');
  assert.equal(fmt(1.005), '1.01');
  assert.equal(fmtLimit(100), '100.00');
  assert.equal(fmtLimit(0.05), '0.05');
  assert.equal(fmtLimit(138.059999), '138.059999');
});

test('numeroALetras: leyenda 1000', () => {
  assert.equal(numeroALetras(336, 'PEN'), 'SON TRESCIENTOS TREINTA Y SEIS CON 00/100 SOLES');
  assert.equal(numeroALetras(1280.5, 'PEN'), 'SON MIL DOSCIENTOS OCHENTA CON 50/100 SOLES');
  assert.equal(numeroALetras(0.9, 'USD'), 'SON CERO CON 90/100 DOLARES AMERICANOS');
  assert.equal(numeroALetras(100, 'PEN'), 'SON CIEN CON 00/100 SOLES');
  assert.equal(numeroALetras(1_000_000, 'PEN'), 'SON UN MILLON CON 00/100 SOLES');
  // El redondeo de centavos no debe desbordar (9.999 -> 10.00).
  assert.equal(numeroALetras(9.999, 'PEN'), 'SON DIEZ CON 00/100 SOLES');
});

test('dates: respeta el offset del payload', () => {
  assert.equal(isoDate('2026-07-29T23:30:00-05:00'), '2026-07-29');
  assert.equal(isoTime('2026-07-29T23:30:00-05:00'), '23:30:00');
  assert.equal(isoTime('2026-07-29'), '00:00:00');
});

test('catálogo 07: mapeo de afectación a tributo', () => {
  assert.equal(afectacionDe('10'), 'gravado');
  assert.equal(afectacionDe('17'), 'ivap');
  assert.equal(afectacionDe('21'), 'gratuito');
  assert.equal(tributoDe('20').id, '9997');
  assert.equal(tributoDe('30').id, '9998');
  assert.equal(tributoDe('40').id, '9995');
  assert.throws(() => afectacionDe('99'));
});

test('totales: calcula IGV, valor de venta y total', () => {
  const doc = completarTotales(facturaBase());
  assert.equal(doc.details[0]!.mtoValorVenta, 200);
  assert.equal(doc.details[0]!.igv, 36);
  assert.equal(doc.details[0]!.mtoPrecioUnitario, 118);
  assert.equal(doc.mtoOperGravadas, 200);
  assert.equal(doc.mtoIGV, 36);
  assert.equal(doc.totalImpuestos, 36);
  assert.equal(doc.valorVenta, 200);
  assert.equal(doc.mtoImpVenta, 236);
  assert.equal(doc.legends?.[0]?.code, '1000');
});

test('totales: exonerado no genera IGV y suma a su propia base', () => {
  const doc = completarTotales(facturaBase({
    details: [
      { unidad: 'NIU', descripcion: 'GRAVADO', cantidad: 1, mtoValorUnitario: 100 },
      { unidad: 'NIU', descripcion: 'EXONERADO', cantidad: 1, mtoValorUnitario: 50, tipAfeIgv: '20' },
    ],
  }));
  assert.equal(doc.mtoOperGravadas, 100);
  assert.equal(doc.mtoOperExoneradas, 50);
  assert.equal(doc.mtoIGV, 18);
  assert.equal(doc.mtoImpVenta, 168);
});

test('totales: ISC entra en la base del IGV', () => {
  const doc = completarTotales(facturaBase({
    details: [{
      unidad: 'NIU', descripcion: 'BEBIDA', cantidad: 2, mtoValorUnitario: 100,
      tipSisIsc: '01', porcentajeIsc: 17,
    }],
  }));
  assert.equal(doc.details[0]!.isc, 34);
  assert.equal(doc.details[0]!.mtoBaseIgv, 234);
  assert.equal(doc.details[0]!.igv, 42.12);
  assert.equal(doc.details[0]!.mtoPrecioUnitario, 138.06);
  assert.equal(doc.totalImpuestos, 76.12);
  assert.equal(doc.mtoImpVenta, 276.12);
});

test('totales: ICBPER se calcula por cantidad de bolsas', () => {
  const doc = completarTotales(facturaBase({
    details: [{ unidad: 'NIU', descripcion: 'BOLSA', cantidad: 4, mtoValorUnitario: 0.05, factorIcbper: 0.5 }],
  }));
  assert.equal(doc.details[0]!.icbper, 2);
  assert.equal(doc.icbper, 2);
  assert.equal(doc.totalImpuestos, 2.04);
});

test('totales: operación gratuita no suma al importe a pagar', () => {
  const doc = completarTotales(facturaBase({
    details: [{ unidad: 'NIU', descripcion: 'MUESTRA', cantidad: 2, mtoValorGratuito: 100, tipAfeIgv: '11' }],
  }));
  assert.equal(doc.mtoOperGratuitas, 200);
  assert.equal(doc.mtoIGVGratuitas, 36);
  assert.equal(doc.mtoIGV, 0);
  assert.equal(doc.mtoImpVenta, 0);
  assert.ok(doc.legends?.some((l) => l.code === '1002'));
});

test('totales: no sobrescribe los importes enviados por el emisor', () => {
  const doc = completarTotales(facturaBase({ mtoImpVenta: 999, mtoIGV: 1 }));
  assert.equal(doc.mtoImpVenta, 999);
  assert.equal(doc.mtoIGV, 1);
});

test('validación: detecta totales incoherentes', () => {
  const doc = completarTotales(facturaBase({ mtoOperGravadas: 500 }));
  const errores = validarTotales(doc);
  assert.equal(errores.length, 1);
  assert.match(errores[0]!, /no coincide/);
});

test('UBL: estructura de la factura', () => {
  const xml = buildSaleXml(toDoc(facturaBase()));
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?><Invoice /);
  assert.match(xml, /<cbc:UBLVersionID>2.1<\/cbc:UBLVersionID>/);
  assert.match(xml, /<cbc:CustomizationID>2.0<\/cbc:CustomizationID>/);
  assert.match(xml, /<cbc:ID>F001-1<\/cbc:ID>/);
  assert.match(xml, /<cbc:IssueDate>2026-07-29<\/cbc:IssueDate>/);
  assert.match(xml, /<cbc:IssueTime>10:30:00<\/cbc:IssueTime>/);
  assert.match(xml, /<cbc:InvoiceTypeCode listID="0101">01<\/cbc:InvoiceTypeCode>/);
  assert.match(xml, /<ext:ExtensionContent\/>/);
  assert.match(xml, /<cbc:ID schemeID="6">20000000001<\/cbc:ID>/);
  assert.match(xml, /<cbc:ID schemeID="6">20000000002<\/cbc:ID>/);
  assert.match(xml, /<cbc:PayableAmount currencyID="PEN">236.00<\/cbc:PayableAmount>/);
  assert.match(xml, /<cac:InvoiceLine>/);
  assert.match(xml, /<cbc:InvoicedQuantity unitCode="NIU">2.00<\/cbc:InvoicedQuantity>/);
  assert.match(xml, /<cbc:TaxExemptionReasonCode>10<\/cbc:TaxExemptionReasonCode>/);
  assert.match(xml, /<cbc:ID>1000<\/cbc:ID><cbc:Name>IGV<\/cbc:Name><cbc:TaxTypeCode>VAT<\/cbc:TaxTypeCode>/);
  // El orden de los elementos importa para el XSD de SUNAT.
  assert.ok(xml.indexOf('cac:Signature') < xml.indexOf('cac:AccountingSupplierParty'));
  assert.ok(xml.indexOf('cac:AccountingSupplierParty') < xml.indexOf('cac:AccountingCustomerParty'));
  assert.ok(xml.indexOf('cac:TaxTotal') < xml.indexOf('cac:LegalMonetaryTotal'));
  assert.ok(xml.indexOf('cac:LegalMonetaryTotal') < xml.indexOf('cac:InvoiceLine'));
});

test('UBL: nota de crédito usa CreditNote y su referencia', () => {
  const parsed = noteSchema.parse({
    tipoDoc: '07', serie: 'FC01', correlativo: '1', fechaEmision: '2026-07-29T00:00:00-05:00',
    tipDocAfectado: '01', numDocfectado: 'F001-1', codMotivo: '01', desMotivo: 'ANULACION',
    tipoMoneda: 'PEN', client: clientData, company,
    details: [{ unidad: 'NIU', descripcion: 'PRODUCTO 1', cantidad: 1, mtoValorUnitario: 100 }],
  });
  const doc = { ...completarTotales(parsed), company, correlativo: '1', fechaEmision: parsed.fechaEmision! } as SaleDoc;
  const xml = buildSaleXml(doc);
  assert.match(xml, /<CreditNote /);
  assert.match(xml, /<cac:DiscrepancyResponse><cbc:ReferenceID>F001-1<\/cbc:ReferenceID><cbc:ResponseCode>01<\/cbc:ResponseCode>/);
  assert.match(xml, /<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F001-1<\/cbc:ID><cbc:DocumentTypeCode>01<\/cbc:DocumentTypeCode>/);
  assert.match(xml, /<cac:CreditNoteLine>/);
  assert.match(xml, /<cbc:CreditedQuantity unitCode="NIU">1.00<\/cbc:CreditedQuantity>/);
  assert.doesNotMatch(xml, /InvoiceTypeCode/);
});

test('UBL: nota de débito usa DebitNote y RequestedMonetaryTotal', () => {
  const parsed = noteSchema.parse({
    tipoDoc: '08', serie: 'FD01', correlativo: '1', fechaEmision: '2026-07-29T00:00:00-05:00',
    tipDocAfectado: '01', numDocfectado: 'F001-1', codMotivo: '01', desMotivo: 'INTERES',
    tipoMoneda: 'PEN', client: clientData, company,
    details: [{ unidad: 'ZZ', descripcion: 'INTERES', cantidad: 1, mtoValorUnitario: 50 }],
  });
  const doc = { ...completarTotales(parsed), company, correlativo: '1', fechaEmision: parsed.fechaEmision! } as SaleDoc;
  const xml = buildSaleXml(doc);
  assert.match(xml, /<DebitNote /);
  assert.match(xml, /<cac:RequestedMonetaryTotal>/);
  assert.match(xml, /<cbc:DebitedQuantity unitCode="ZZ">1.00<\/cbc:DebitedQuantity>/);
});

test('UBL: resumen diario y comunicación de baja', () => {
  const rc = buildSummaryXml({
    correlativo: '1', fecGeneracion: '2026-07-29', fecResumen: '2026-07-30', moneda: 'PEN',
    company, xmlId: 'RC-20260730-1',
    details: [{
      tipoDoc: '03', serieNro: 'B001-1', estado: '1', clienteTipo: '1', clienteNro: '46543212',
      total: 118, mtoOperGravadas: 100, mtoIGV: 18,
    }],
  });
  assert.match(rc, /<SummaryDocuments /);
  assert.match(rc, /<cbc:CustomizationID>1.1<\/cbc:CustomizationID>/);
  assert.match(rc, /<cbc:ID>RC-20260730-1<\/cbc:ID>/);
  assert.match(rc, /<cbc:ReferenceDate>2026-07-29<\/cbc:ReferenceDate>/);
  assert.match(rc, /<cbc:IssueDate>2026-07-30<\/cbc:IssueDate>/);
  assert.match(rc, /<sac:SummaryDocumentsLine>/);
  assert.match(rc, /<cbc:InstructionID>01<\/cbc:InstructionID>/);

  const ra = buildVoidedXml({
    correlativo: '1', fecGeneracion: '2026-07-29', fecComunicacion: '2026-07-30', company, xmlId: 'RA-20260730-1',
    details: [{ tipoDoc: '01', serie: 'F001', correlativo: '1', desMotivoBaja: 'ERROR EN CALCULOS' }],
  });
  assert.match(ra, /<VoidedDocuments /);
  assert.match(ra, /<sac:DocumentSerialID>F001<\/sac:DocumentSerialID>/);
  assert.match(ra, /<sac:VoidReasonDescription><!\[CDATA\[ERROR EN CALCULOS\]\]><\/sac:VoidReasonDescription>/);
});

test('firma: XMLDSig RSA-SHA256 dentro de ExtensionContent', () => {
  const { material } = generateSelfSignedPfx('20000000001', 'MI TIENDA S.A.C.', 'clave');
  const xml = buildSaleXml(toDoc(facturaBase()));
  const signed = signUbl(xml, material.privateKeyPem, material.certificatePem);
  assert.match(signed.xml, /<ext:ExtensionContent><ds:Signature/);
  assert.match(signed.xml, /Id="SIGN-CPE"/);
  assert.match(signed.xml, /rsa-sha256/);
  assert.match(signed.xml, /<ds:X509Certificate>/);
  assert.equal(signed.digestValue.length, 44, 'el digest SHA-256 en base64 mide 44 caracteres');
  assert.ok(signed.signatureValue.length > 300);
});

test('certificado: se lee el PKCS#12 y se extrae el RUC del subject', () => {
  const { pfx, material } = generateSelfSignedPfx('20123456789', 'OTRA EMPRESA S.A.C.', 'secreta');
  const cargado = loadCertificate(pfx, 'secreta');
  assert.equal(cargado.ruc, '20123456789');
  assert.equal(cargado.certificatePem, material.certificatePem);
  assert.throws(() => loadCertificate(pfx, 'incorrecta'));
});

test('secretos: AES-256-GCM ida y vuelta', async () => {
  const vault = new LocalAesVault(Buffer.alloc(32, 7).toString('base64'));
  const cifrado = await vault.encrypt('MODDATOS');
  assert.notEqual(cifrado, 'MODDATOS');
  assert.equal((await vault.decrypt(cifrado)).toString('utf8'), 'MODDATOS');
  const alterado = cifrado.slice(0, -4) + 'AAAA';
  await assert.rejects(() => vault.decrypt(alterado));
});

test('CDR: parseo de la constancia de recepción', () => {
  const aceptado = parseCdrXml(`<?xml version="1.0"?>
    <ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
      xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
      xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
      <cac:DocumentResponse><cac:Response>
        <cbc:ReferenceID>F001-1</cbc:ReferenceID>
        <cbc:ResponseCode>0</cbc:ResponseCode>
        <cbc:Description>La Factura numero F001-1, ha sido aceptada</cbc:Description>
      </cac:Response></cac:DocumentResponse>
      <cbc:Note>4000 - Observación de prueba</cbc:Note>
    </ar:ApplicationResponse>`);
  assert.equal(aceptado.code, '0');
  assert.equal(aceptado.accepted, true);
  assert.equal(aceptado.severity, 'aceptado');
  assert.deepEqual(aceptado.notes, ['4000 - Observación de prueba']);

  const rechazado = parseCdrXml(`<ApplicationResponse xmlns:cbc="urn:x">
    <cbc:ResponseCode>2335</cbc:ResponseCode><cbc:Description>El dato ingresado no cumple</cbc:Description>
  </ApplicationResponse>`);
  assert.equal(rechazado.accepted, false);
  assert.equal(rechazado.severity, 'rechazado');
});

test('errores SUNAT: clasificación y reintentabilidad', () => {
  assert.equal(clasificar('0'), 'aceptado');
  assert.equal(clasificar('0102'), 'error');
  assert.equal(clasificar('2335'), 'rechazado');
  assert.equal(clasificar('4000'), 'observacion');
  assert.equal(esReintentable('0102'), true, 'un error de credenciales/servicio se reintenta');
  assert.equal(esReintentable('2335'), false, 'un rechazo nunca debe reintentarse');
});

test('QR: contenido normativo separado por pipes', () => {
  const doc = toDoc(facturaBase());
  const texto = qrText(doc, 'HASH==');
  assert.equal(texto, '20000000001|01|F001|1|36.00|236.00|2026-07-29|6|20000000002|HASH==');
});

test('naming: el RC lleva la fecha de generación del resumen', () => {
  const { name, xmlId } = nombreResumen('20000000001', '2026-07-30', '1');
  assert.equal(name, '20000000001-RC-20260730-1');
  assert.equal(xmlId, 'RC-20260730-1');
});

test('UBL: guía de remisión (DespatchAdvice 2022)', async () => {
  const { despatchSchema } = await import('../src/domain/schemas.ts');
  const { buildDespatchXml } = await import('../src/ubl/despatch.ts');
  const input = despatchSchema.parse({
    tipoDoc: '09', serie: 'T001', correlativo: '1', fechaEmision: '2026-07-29T08:00:00-05:00',
    company, destinatario: { tipoDoc: '6', numDoc: '20000000002', rznSocial: 'EMPRESA A' },
    envio: {
      codTraslado: '01', desTraslado: 'VENTA', modTraslado: '01',
      fecTraslado: '2026-07-30', pesoTotal: 12.5, undPesoTotal: 'KGM',
      llegada: { ubigueo: '150101', direccion: 'AV LIMA 100' },
      partida: { ubigueo: '150203', direccion: 'AV ITALIA 200' },
      transportista: { tipoDoc: '6', numDoc: '20000000003', rznSocial: 'TRANSPORTES S.A.C', placa: 'ABI-453' },
    },
    details: [{ codigo: 'PROD1', unidad: 'ZZ', descripcion: 'PRODUCTO 1', cantidad: 2 }],
  });
  const xml = buildDespatchXml({ ...input, company, correlativo: '1', fechaEmision: input.fechaEmision! });
  assert.match(xml, /<DespatchAdvice /);
  assert.match(xml, /<cbc:ID>T001-1<\/cbc:ID>/);
  assert.match(xml, /<cbc:DespatchAdviceTypeCode[^>]*>09<\/cbc:DespatchAdviceTypeCode>/);
  assert.match(xml, /<cbc:GrossWeightMeasure unitCode="KGM">12.500<\/cbc:GrossWeightMeasure>/);
  assert.match(xml, /<cac:DespatchSupplierParty>/);
  assert.match(xml, /<cac:DeliveryCustomerParty>/);
  assert.match(xml, /<cbc:HandlingCode[^>]*>01<\/cbc:HandlingCode>/);
  assert.match(xml, /<cac:DeliveryAddress>.*150101.*AV LIMA 100.*<\/cac:DeliveryAddress>/);
  assert.match(xml, /<cac:DespatchAddress>.*150203.*AV ITALIA 200.*<\/cac:DespatchAddress>/);
  assert.match(xml, /<cac:DespatchLine>/);
  assert.match(xml, /<cbc:DeliveredQuantity unitCode="ZZ">2.00<\/cbc:DeliveredQuantity>/);
  // El orden exigido por el XSD: firma → emisor → destinatario → envío → líneas.
  assert.ok(xml.indexOf('cac:Signature') < xml.indexOf('cac:DespatchSupplierParty'));
  assert.ok(xml.indexOf('cac:Shipment') < xml.indexOf('cac:DespatchLine'));
});

test('UBL: comprobante de retención (20)', async () => {
  const { retentionSchema } = await import('../src/domain/schemas.ts');
  const { buildRetentionXml } = await import('../src/ubl/retention.ts');
  const input = retentionSchema.parse({
    serie: 'R001', correlativo: '1', fechaEmision: '2026-07-29T10:00:00-05:00',
    proveedor: { tipoDoc: '6', numDoc: '20000000002', rznSocial: 'PROVEEDOR S.A.C.' },
    regimen: '01', tasa: 3, impRetenido: 10, impPagado: 200, observacion: 'RETENCION IGV',
    details: [{
      tipoDoc: '01', numDoc: 'F001-1', fechaEmision: '2026-07-20', moneda: 'PEN', impTotal: 210,
      fechaRetencion: '2026-07-29', impRetenido: 10, impPagar: 200,
      pagos: [{ moneda: 'PEN', importe: 200, fecha: '2026-07-29' }],
    }],
  });
  const xml = buildRetentionXml({ ...input, company, correlativo: '1', fechaEmision: input.fechaEmision! });
  assert.match(xml, /<Retention xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:Retention-1"/);
  assert.match(xml, /<cbc:CustomizationID>1.0<\/cbc:CustomizationID>/);
  assert.match(xml, /<sac:SUNATRetentionSystemCode>01<\/sac:SUNATRetentionSystemCode>/);
  assert.match(xml, /<sac:SUNATRetentionPercent>3.00<\/sac:SUNATRetentionPercent>/);
  assert.match(xml, /<cbc:TotalInvoiceAmount currencyID="PEN">10.00<\/cbc:TotalInvoiceAmount>/);
  assert.match(xml, /<sac:SUNATTotalPaid currencyID="PEN">200.00<\/sac:SUNATTotalPaid>/);
  assert.match(xml, /<sac:SUNATRetentionAmount currencyID="PEN">10.00<\/sac:SUNATRetentionAmount>/);
  assert.match(xml, /<sac:SUNATNetTotalPaid currencyID="PEN">200.00<\/sac:SUNATNetTotalPaid>/);
  assert.match(xml, /<cac:Payment><cbc:ID>1<\/cbc:ID>/);
  // La firma va antes del ID y el emisor se declara como cac:AgentParty.
  assert.ok(xml.indexOf('cac:Signature') < xml.indexOf('<cbc:ID>R001-1</cbc:ID>'));
  assert.match(xml, /<cac:AgentParty>/);
  assert.match(xml, /<cac:ReceiverParty>/);
});

test('UBL: comprobante de percepción (40) usa AgentParty, no SellerSupplierParty', async () => {
  const { perceptionSchema } = await import('../src/domain/schemas.ts');
  const { buildPerceptionXml } = await import('../src/ubl/retention.ts');
  const input = perceptionSchema.parse({
    serie: 'P001', correlativo: '1', fechaEmision: '2026-07-29T10:00:00-05:00',
    proveedor: { tipoDoc: '6', numDoc: '20000000002', rznSocial: 'CLIENTE S.A.C.' },
    regimen: '01', tasa: 2, impPercibido: 4, impCobrado: 204,
    details: [{
      tipoDoc: '01', numDoc: 'F001-2', fechaEmision: '2026-07-20', moneda: 'PEN', impTotal: 200,
      fechaPercepcion: '2026-07-29', impPercibido: 4, impCobrar: 204,
    }],
  });
  const xml = buildPerceptionXml({ ...input, company, correlativo: '1', fechaEmision: input.fechaEmision! });
  assert.match(xml, /<Perception xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:Perception-1"/);
  assert.match(xml, /<sac:SUNATPerceptionSystemCode>01<\/sac:SUNATPerceptionSystemCode>/);
  assert.match(xml, /<sac:SUNATPerceptionPercent>2.00<\/sac:SUNATPerceptionPercent>/);
  assert.match(xml, /<sac:SUNATTotalCashed currencyID="PEN">204.00<\/sac:SUNATTotalCashed>/);
  assert.match(xml, /<sac:SUNATPerceptionAmount currencyID="PEN">4.00<\/sac:SUNATPerceptionAmount>/);
  assert.match(xml, /<sac:SUNATNetTotalCashed currencyID="PEN">204.00<\/sac:SUNATNetTotalCashed>/);
  // SUNAT rechaza con 0306 si se usa cac:SellerSupplierParty en lugar de AgentParty.
  assert.match(xml, /<cac:AgentParty>/);
  assert.doesNotMatch(xml, /SellerSupplierParty/);
});

test('retención: el tipo de cambio se declara con 6 decimales', async () => {
  const { retentionSchema } = await import('../src/domain/schemas.ts');
  const { buildRetentionXml } = await import('../src/ubl/retention.ts');
  const input = retentionSchema.parse({
    serie: 'R001', correlativo: '1', fechaEmision: '2026-07-29T00:00:00-05:00',
    proveedor: { tipoDoc: '6', numDoc: '20000000002', rznSocial: 'PROVEEDOR' },
    impRetenido: 10, impPagado: 200,
    details: [{
      tipoDoc: '01', numDoc: 'F001-1', fechaEmision: '2026-07-20', moneda: 'USD', impTotal: 60,
      fechaRetencion: '2026-07-29', impRetenido: 10, impPagar: 200,
      tipoCambio: { monedaRef: 'USD', monedaObj: 'PEN', factor: 3.751, fecha: '2026-07-29' },
    }],
  });
  const xml = buildRetentionXml({ ...input, company, correlativo: '1', fechaEmision: input.fechaEmision! });
  assert.match(xml, /<cbc:CalculationRate>3.751000<\/cbc:CalculationRate>/);
  assert.match(xml, /<cbc:SourceCurrencyCode>USD<\/cbc:SourceCurrencyCode>/);
});

test('validación: un descuento global que afecta la base no es un error', () => {
  // El descuento global (catálogo 53) reduce mtoOperGravadas respecto a la suma
  // de las líneas; validarTotales no debe rechazarlo.
  const doc = completarTotales(facturaBase({
    details: [
      { unidad: 'NIU', descripcion: 'CAFE', cantidad: 1, mtoValorUnitario: 20 },
      { unidad: 'NIU', descripcion: 'PASTA', cantidad: 1, mtoValorUnitario: 50 },
    ],
    descuentos: [{ codTipo: '02', factor: 1, monto: 3, montoBase: 3 }],
    mtoOperGravadas: 67,
    mtoIGV: 12.06,
    valorVenta: 67,
    subTotal: 79.06,
    mtoImpVenta: 79.06,
  }));
  assert.deepEqual(validarTotales(doc), []);
});

test('validación: los anticipos descontados de la base no son un error', () => {
  const doc = completarTotales(facturaBase({
    details: [{ unidad: 'NIU', descripcion: 'PRODUCTO 1', cantidad: 1, mtoValorUnitario: 200 }],
    descuentos: [{ codTipo: '04', factor: 1, monto: 100, montoBase: 100 }],
    anticipos: [{ tipoDocRel: '02', nroDocRel: 'F001-111', total: 100 }],
    totalAnticipos: 100,
    mtoOperGravadas: 100,
    mtoIGV: 18,
    valorVenta: 200,
    subTotal: 236,
    mtoImpVenta: 136,
  }));
  assert.deepEqual(validarTotales(doc), []);
});

test('validación: sigue detectando un total inventado', () => {
  const doc = completarTotales(facturaBase({ mtoOperGravadas: 500 }));
  assert.equal(validarTotales(doc).length, 1);
});

test('UBL: la percepción en factura declara el factor tal cual (regla 2798)', () => {
  const doc = toDoc(facturaBase({
    tipoOperacion: '2001',
    perception: { codReg: '51', porcentaje: 0.02, mtoBase: 200, mto: 4, mtoTotal: 204 },
  }));
  const xml = buildSaleXml(doc);
  assert.match(xml, /<cbc:MultiplierFactorNumeric>0.02<\/cbc:MultiplierFactorNumeric>/);
  assert.match(xml, /<cbc:AllowanceChargeReasonCode>51<\/cbc:AllowanceChargeReasonCode>/);
  assert.match(xml, /<cbc:Amount currencyID="PEN">4.00<\/cbc:Amount>/);
  assert.match(xml, /<cac:PaymentTerms><cbc:ID>Percepcion<\/cbc:ID><cbc:Amount currencyID="PEN">204.00<\/cbc:Amount>/);
});

test('UBL: IVAP usa el tributo 1016 y la afectación 17', () => {
  const doc = toDoc(facturaBase({
    details: [{ unidad: 'NIU', descripcion: 'SACOS DE ARROZ', cantidad: 900, mtoValorUnitario: 100, tipAfeIgv: '17', porcentajeIgv: 4 }],
  }));
  const xml = buildSaleXml(doc);
  assert.equal(doc.mtoBaseIvap, 90000);
  assert.equal(doc.mtoIvap, 3600);
  assert.equal(doc.mtoOperGravadas, undefined, 'el IVAP no suma a las operaciones gravadas con IGV');
  assert.match(xml, /<cbc:ID>1016<\/cbc:ID><cbc:Name>IVAP<\/cbc:Name><cbc:TaxTypeCode>VAT<\/cbc:TaxTypeCode>/);
  assert.match(xml, /<cbc:TaxExemptionReasonCode>17<\/cbc:TaxExemptionReasonCode>/);
});

test('UBL: el ISC declara el sistema de cálculo en TierRange', () => {
  const doc = toDoc(facturaBase({
    details: [{ unidad: 'NIU', descripcion: 'BEBIDA', cantidad: 2, mtoValorUnitario: 100, tipSisIsc: '01', porcentajeIsc: 17 }],
  }));
  const xml = buildSaleXml(doc);
  assert.match(xml, /<cbc:TierRange>01<\/cbc:TierRange>/);
  assert.match(xml, /<cbc:ID>2000<\/cbc:ID><cbc:Name>ISC<\/cbc:Name><cbc:TaxTypeCode>EXC<\/cbc:TaxTypeCode>/);
});

test('UBL: una factura con varias afectaciones genera un TaxSubtotal por cada una', () => {
  const doc = toDoc(facturaBase({
    details: [
      { unidad: 'NIU', descripcion: 'GRAVADO', cantidad: 1, mtoValorUnitario: 100 },
      { unidad: 'NIU', descripcion: 'EXONERADO', cantidad: 1, mtoValorUnitario: 50, tipAfeIgv: '20' },
      { unidad: 'NIU', descripcion: 'INAFECTO', cantidad: 1, mtoValorUnitario: 100, tipAfeIgv: '30' },
      { unidad: 'NIU', descripcion: 'GRATUITO GRAVADO', cantidad: 2, mtoValorGratuito: 50, tipAfeIgv: '13' },
      { unidad: 'NIU', descripcion: 'GRATUITO INAFECTO', cantidad: 2, mtoValorGratuito: 50, tipAfeIgv: '32' },
    ],
  }));
  const xml = buildSaleXml(doc);
  for (const tributo of ['1000', '9997', '9998', '9996']) {
    assert.match(xml, new RegExp(`<cbc:ID>${tributo}</cbc:ID>`), `falta el tributo ${tributo}`);
  }
  assert.equal(doc.mtoOperGravadas, 100);
  assert.equal(doc.mtoOperExoneradas, 50);
  assert.equal(doc.mtoOperInafectas, 100);
  assert.equal(doc.mtoOperGratuitas, 200);
  // Las gratuitas no entran en el importe a pagar.
  assert.equal(doc.mtoImpVenta, 268);
});

test('UBL: una nota de crédito puede afectar una boleta', () => {
  const parsed = noteSchema.parse({
    tipoDoc: '07', serie: 'BB01', correlativo: '1', fechaEmision: '2026-07-29T00:00:00-05:00',
    tipDocAfectado: '03', numDocfectado: 'B001-12', codMotivo: '01', desMotivo: 'ANULACION DE LA OPERACION',
    tipoMoneda: 'PEN', client: { tipoDoc: '1', numDoc: '46543212', rznSocial: 'JUAN PEREZ' }, company,
    details: [{ unidad: 'NIU', descripcion: 'PRODUCTO 1', cantidad: 2, mtoValorUnitario: 50 }],
  });
  const doc = { ...completarTotales(parsed), company, correlativo: '1', fechaEmision: parsed.fechaEmision! } as SaleDoc;
  const xml = buildSaleXml(doc);
  assert.match(xml, /<cbc:ID>B001-12<\/cbc:ID><cbc:DocumentTypeCode>03<\/cbc:DocumentTypeCode>/);
  assert.match(xml, /<cbc:ID schemeID="1">46543212<\/cbc:ID>/);
});

test('UBL: el resumen diario acepta otra moneda y notas que afectan boletas', () => {
  const xml = buildSummaryXml({
    correlativo: '1', fecGeneracion: '2026-07-29', fecResumen: '2026-07-30', moneda: 'USD',
    company, xmlId: 'RC-20260730-1',
    details: [
      { tipoDoc: '03', serieNro: 'B001-1', estado: '3', clienteTipo: '1', clienteNro: '46543212', total: 100, mtoOperGravadas: 84.75, mtoIGV: 15.25 },
      {
        tipoDoc: '07', serieNro: 'BB01-1', estado: '1', clienteTipo: '1', clienteNro: '46543212',
        docReferencia: { tipoDoc: '03', nroDoc: 'B001-1' },
        total: 50, mtoOperGravadas: 42.37, mtoIGV: 7.63,
      },
    ],
  });
  assert.match(xml, /<sac:TotalAmount currencyID="USD">100.00<\/sac:TotalAmount>/);
  assert.match(xml, /<cbc:ConditionCode>3<\/cbc:ConditionCode>/);
  assert.match(xml, /<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>B001-1<\/cbc:ID><cbc:DocumentTypeCode>03<\/cbc:DocumentTypeCode>/);
});
