import PDFDocument from 'pdfkit';
import type { SaleDoc } from '../ubl/types.ts';
import { NOMBRE_TIPO_DOC, NOMBRE_TIPO_DOC_IDENTIDAD } from '../domain/catalogs.ts';
import { fmt, fmtLimit } from '../util/money.ts';
import { isoDate } from '../util/dates.ts';
import { qrPng, qrText } from '../services/qr.ts';

export interface PdfOptions {
  /** 'a4' (formato carta) o 'ticket' (rollo de 80 mm). */
  formato?: 'a4' | 'ticket';
  logo?: Buffer;
  digestValue?: string;
  /** Texto de la CDR, si ya se conoce (ej. "La Factura F001-1, ha sido aceptada"). */
  observacionSunat?: string;
}

/** Representación impresa del comprobante con el QR normativo. */
export async function renderSalePdf(doc: SaleDoc, opts: PdfOptions = {}): Promise<Buffer> {
  const ticket = opts.formato === 'ticket';
  const qr = await qrPng(qrText(doc, opts.digestValue ?? ''), ticket ? 140 : 200);

  const pdf = ticket
    ? new PDFDocument({ size: [226.77, 1200], margins: { top: 12, bottom: 12, left: 10, right: 10 } })
    : new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 36, left: 40, right: 40 } });

  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  if (ticket) renderTicket(pdf, doc, qr, opts);
  else renderA4(pdf, doc, qr, opts);

  pdf.end();
  return done;
}

type Pdf = PDFKit.PDFDocument;

function money(v: number | undefined, cur: string): string {
  return `${cur} ${fmt(v ?? 0)}`;
}

function renderA4(pdf: Pdf, doc: SaleDoc, qr: Buffer, opts: PdfOptions): void {
  const cur = doc.tipoMoneda;
  const left = 40;
  const right = 555;

  if (opts.logo) {
    try {
      pdf.image(opts.logo, left, 36, { fit: [120, 60] });
    } catch {
      // Un logo corrupto no debe impedir la emisión del PDF.
    }
  }

  pdf.font('Helvetica-Bold').fontSize(12).text(doc.company.razonSocial, left, 100, { width: 300 });
  pdf.font('Helvetica').fontSize(9);
  if (doc.company.nombreComercial) pdf.text(doc.company.nombreComercial, { width: 300 });
  const addr = doc.company.address;
  if (addr?.direccion) {
    pdf.text([addr.direccion, addr.distrito, addr.provincia, addr.departamento].filter(Boolean).join(' - '), { width: 300 });
  }
  if (doc.company.telephone) pdf.text(`Teléfono: ${doc.company.telephone}`);
  if (doc.company.email) pdf.text(doc.company.email);

  // Recuadro del tipo de comprobante.
  const boxX = 360;
  pdf.rect(boxX, 40, right - boxX, 70).stroke();
  pdf.font('Helvetica-Bold').fontSize(11)
    .text(`R.U.C. ${doc.company.ruc}`, boxX, 50, { width: right - boxX, align: 'center' })
    .text(NOMBRE_TIPO_DOC[doc.tipoDoc] ?? 'COMPROBANTE ELECTRÓNICO', { width: right - boxX, align: 'center' })
    .fontSize(13).text(`${doc.serie}-${doc.correlativo}`, { width: right - boxX, align: 'center' });

  let y = 180;
  pdf.font('Helvetica').fontSize(9);
  // El alto de cada fila se mide para que los valores largos (razón social,
  // direcciones) no se solapen con la fila siguiente.
  const labelWidth = 108;
  const valueWidth = 300;
  const row = (label: string, value: string) => {
    pdf.font('Helvetica-Bold').text(label, left, y, { width: labelWidth });
    pdf.font('Helvetica');
    const height = pdf.heightOfString(value, { width: valueWidth });
    pdf.text(value, left + labelWidth, y, { width: valueWidth });
    y += Math.max(14, height + 2);
  };
  row('Señor(es):', doc.client.rznSocial);
  row(`${NOMBRE_TIPO_DOC_IDENTIDAD[doc.client.tipoDoc] ?? 'Documento'}:`, doc.client.numDoc);
  if (doc.client.address?.direccion) row('Dirección:', doc.client.address.direccion);
  row('Fecha de emisión:', isoDate(doc.fechaEmision));
  if (doc.fecVencimiento) row('Fecha de vencimiento:', isoDate(doc.fecVencimiento));
  row('Moneda:', cur);
  if (doc.formaPago) row('Forma de pago:', doc.formaPago.tipo);
  if (doc.tipoDoc === '07' || doc.tipoDoc === '08') {
    row('Documento afectado:', `${doc.tipDocAfectado ?? ''} ${doc.numDocfectado ?? ''}`);
    row('Motivo:', doc.desMotivo ?? '');
  }

  // Cabecera de la tabla de ítems.
  y += 8;
  const cols = [
    { title: 'CANT.', x: left, w: 40, align: 'right' as const },
    { title: 'UM', x: left + 44, w: 28, align: 'left' as const },
    { title: 'DESCRIPCIÓN', x: left + 76, w: 240, align: 'left' as const },
    { title: 'V. UNIT.', x: left + 320, w: 60, align: 'right' as const },
    { title: 'IGV', x: left + 384, w: 55, align: 'right' as const },
    { title: 'IMPORTE', x: left + 443, w: 72, align: 'right' as const },
  ];
  pdf.font('Helvetica-Bold').fontSize(8);
  pdf.rect(left, y - 2, right - left, 16).fill('#eeeeee').fillColor('black');
  for (const c of cols) pdf.text(c.title, c.x, y + 2, { width: c.w, align: c.align });
  y += 18;

  pdf.font('Helvetica').fontSize(8);
  for (const d of doc.details) {
    const height = Math.max(12, pdf.heightOfString(d.descripcion, { width: 240 }));
    if (y + height > 700) {
      pdf.addPage();
      y = 50;
    }
    pdf.text(fmtLimit(d.cantidad, 3), cols[0]!.x, y, { width: cols[0]!.w, align: 'right' });
    pdf.text(d.unidad, cols[1]!.x, y, { width: cols[1]!.w });
    pdf.text(d.descripcion, cols[2]!.x, y, { width: cols[2]!.w });
    pdf.text(fmtLimit(d.mtoValorUnitario ?? 0, 4), cols[3]!.x, y, { width: cols[3]!.w, align: 'right' });
    pdf.text(fmt(d.igv ?? 0), cols[4]!.x, y, { width: cols[4]!.w, align: 'right' });
    pdf.text(fmt(d.mtoValorVenta ?? 0), cols[5]!.x, y, { width: cols[5]!.w, align: 'right' });
    y += height + 4;
  }

  pdf.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;

  const totales: Array<[string, number | undefined]> = [
    ['Op. Gravadas', doc.mtoOperGravadas],
    ['Op. Exoneradas', doc.mtoOperExoneradas],
    ['Op. Inafectas', doc.mtoOperInafectas],
    ['Op. Exportación', doc.mtoOperExportacion],
    ['Op. Gratuitas', doc.mtoOperGratuitas],
    ['ISC', doc.mtoISC],
    ['IGV', doc.mtoIGV],
    ['ICBPER', doc.icbper],
    ['Otros cargos', doc.sumOtrosCargos],
    ['Descuentos', doc.sumOtrosDescuentos],
    ['Anticipos', doc.totalAnticipos],
    ['Redondeo', doc.redondeo],
  ];
  const totalsY = y;
  pdf.fontSize(9);
  for (const [label, value] of totales) {
    if (value === undefined || value === null) continue;
    pdf.font('Helvetica').text(label, 380, y, { width: 90, align: 'right' });
    pdf.text(money(value, cur), 470, y, { width: 85, align: 'right' });
    y += 13;
  }
  pdf.font('Helvetica-Bold').text('IMPORTE TOTAL', 380, y, { width: 90, align: 'right' });
  pdf.text(money(doc.mtoImpVenta, cur), 470, y, { width: 85, align: 'right' });
  y += 20;

  // Leyendas y QR a la izquierda del bloque de totales.
  let leyendaY = totalsY;
  pdf.font('Helvetica').fontSize(8);
  for (const leg of doc.legends ?? []) {
    pdf.text(leg.value, left, leyendaY, { width: 320 });
    leyendaY += 14;
  }
  if (doc.detraccion) {
    pdf.text(`Detracción: ${doc.detraccion.percent}% — ${money(doc.detraccion.mount, 'PEN')} — Cuenta BN ${doc.detraccion.ctaBanco}`, left, leyendaY, { width: 320 });
    leyendaY += 14;
  }
  if (opts.observacionSunat) {
    pdf.text(opts.observacionSunat, left, leyendaY, { width: 320 });
    leyendaY += 14;
  }

  const qrY = Math.max(y, leyendaY) + 10;
  pdf.image(qr, left, qrY, { fit: [110, 110] });
  pdf.fontSize(7).text(
    'Representación impresa de un comprobante de pago electrónico. Consulte su validez en www.sunat.gob.pe',
    left + 120, qrY + 10, { width: 300 },
  );
}

function renderTicket(pdf: Pdf, doc: SaleDoc, qr: Buffer, opts: PdfOptions): void {
  const cur = doc.tipoMoneda;
  const width = 206;
  const center = { width, align: 'center' as const };

  if (opts.logo) {
    try {
      pdf.image(opts.logo, 63, 12, { fit: [80, 40] });
      pdf.moveDown(3);
    } catch { /* logo inválido: se ignora */ }
  }
  pdf.font('Helvetica-Bold').fontSize(9).text(doc.company.razonSocial, center);
  pdf.font('Helvetica').fontSize(7);
  if (doc.company.address?.direccion) pdf.text(doc.company.address.direccion, center);
  pdf.text(`R.U.C. ${doc.company.ruc}`, center);
  pdf.font('Helvetica-Bold').fontSize(8)
    .text(NOMBRE_TIPO_DOC[doc.tipoDoc] ?? 'COMPROBANTE', center)
    .text(`${doc.serie}-${doc.correlativo}`, center);

  pdf.font('Helvetica').fontSize(7).moveDown(0.5);
  pdf.text(`Fecha: ${isoDate(doc.fechaEmision)}`);
  pdf.text(`Cliente: ${doc.client.rznSocial}`);
  pdf.text(`${NOMBRE_TIPO_DOC_IDENTIDAD[doc.client.tipoDoc] ?? 'Doc'}: ${doc.client.numDoc}`);
  pdf.moveDown(0.5).text('-'.repeat(46));

  for (const d of doc.details) {
    pdf.text(d.descripcion, { width });
    pdf.text(
      `${fmtLimit(d.cantidad, 3)} x ${fmtLimit(d.mtoPrecioUnitario ?? 0, 4)}`,
      { width: width - 60, continued: true },
    );
    pdf.text(fmt(d.mtoValorVenta ?? 0), { width: 60, align: 'right' });
  }
  pdf.text('-'.repeat(46));

  const line = (label: string, value: number | undefined) => {
    if (value === undefined || value === null) return;
    pdf.text(label, { width: width - 70, continued: true });
    pdf.text(money(value, cur), { width: 70, align: 'right' });
  };
  line('Op. Gravadas', doc.mtoOperGravadas);
  line('Op. Exoneradas', doc.mtoOperExoneradas);
  line('Op. Inafectas', doc.mtoOperInafectas);
  line('IGV', doc.mtoIGV);
  line('ICBPER', doc.icbper);
  pdf.font('Helvetica-Bold');
  line('TOTAL', doc.mtoImpVenta);
  pdf.font('Helvetica').moveDown(0.5);

  for (const leg of doc.legends ?? []) pdf.fontSize(6).text(leg.value, { width });
  pdf.moveDown(0.5);
  pdf.image(qr, 53, pdf.y, { fit: [100, 100] });
  pdf.y += 105;
  pdf.fontSize(6).text('Representación impresa de un comprobante electrónico', center);
}
