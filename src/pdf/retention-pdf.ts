import PDFDocument from 'pdfkit';
import type { ComprobanteRetPer } from '../ubl/retention.ts';
import { NOMBRE_TIPO_DOC_IDENTIDAD } from '../domain/catalogs.ts';
import { fmt } from '../util/money.ts';
import { isoDate } from '../util/dates.ts';
import { numeroALetras } from '../util/numero-letras.ts';
import { qrPng } from '../services/qr.ts';

const TITULOS = {
  '20': { titulo: 'COMPROBANTE DE RETENCIÓN', total: 'Importe retenido', neto: 'Importe pagado', col: 'RETENIDO', colNeto: 'NETO PAGADO', fecha: 'F. RETENCIÓN' },
  '40': { titulo: 'COMPROBANTE DE PERCEPCIÓN', total: 'Importe percibido', neto: 'Importe cobrado', col: 'PERCIBIDO', colNeto: 'TOTAL A COBRAR', fecha: 'F. PERCEPCIÓN' },
} as const;

/** Representación impresa de un comprobante de retención (20) o percepción (40). */
export async function renderRetPerPdf(tipo: '20' | '40', doc: ComprobanteRetPer, digestValue = ''): Promise<Buffer> {
  const t = TITULOS[tipo];
  const qrTexto = [
    doc.company.ruc, tipo, doc.serie, doc.correlativo,
    fmt(doc.total), isoDate(doc.fechaEmision),
    doc.proveedor.tipoDoc, doc.proveedor.numDoc, digestValue,
  ].join('|');
  const qr = await qrPng(qrTexto, 200);

  const pdf = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 36, left: 40, right: 40 } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const left = 40;
  const right = 555;

  pdf.font('Helvetica-Bold').fontSize(12).text(doc.company.razonSocial, left, 100, { width: 300 });
  pdf.font('Helvetica').fontSize(9);
  if (doc.company.nombreComercial) pdf.text(doc.company.nombreComercial, { width: 300 });
  const addr = doc.company.address;
  if (addr?.direccion) {
    pdf.text([addr.direccion, addr.distrito, addr.provincia, addr.departamento].filter(Boolean).join(' - '), { width: 300 });
  }

  const boxX = 360;
  pdf.rect(boxX, 40, right - boxX, 70).stroke();
  pdf.font('Helvetica-Bold').fontSize(11)
    .text(`R.U.C. ${doc.company.ruc}`, boxX, 50, { width: right - boxX, align: 'center' })
    .text(t.titulo, { width: right - boxX, align: 'center' })
    .fontSize(13).text(`${doc.serie}-${doc.correlativo}`, { width: right - boxX, align: 'center' });

  let y = 180;
  const labelWidth = 130;
  const valueWidth = 300;
  const row = (label: string, value: string) => {
    pdf.font('Helvetica-Bold').fontSize(9).text(label, left, y, { width: labelWidth });
    pdf.font('Helvetica');
    const height = pdf.heightOfString(value, { width: valueWidth });
    pdf.text(value, left + labelWidth, y, { width: valueWidth });
    y += Math.max(14, height + 2);
  };
  row('Señor(es):', doc.proveedor.rznSocial);
  row(`${NOMBRE_TIPO_DOC_IDENTIDAD[doc.proveedor.tipoDoc] ?? 'Documento'}:`, doc.proveedor.numDoc);
  if (doc.proveedor.address?.direccion) row('Dirección:', doc.proveedor.address.direccion);
  row('Fecha de emisión:', isoDate(doc.fechaEmision));
  row('Régimen:', `${doc.regimen} · tasa ${fmt(doc.tasa)} %`);

  y += 8;
  const cols = [
    { title: 'DOC.', x: left, w: 34 },
    { title: 'NÚMERO', x: left + 36, w: 86 },
    { title: 'F. EMISIÓN', x: left + 126, w: 62 },
    { title: 'MON.', x: left + 190, w: 34 },
    { title: 'IMPORTE TOTAL', x: left + 226, w: 78, align: 'right' as const },
    { title: t.fecha, x: left + 308, w: 66 },
    { title: t.col, x: left + 378, w: 62, align: 'right' as const },
    { title: t.colNeto, x: left + 444, w: 71, align: 'right' as const },
  ];
  pdf.font('Helvetica-Bold').fontSize(7.5);
  pdf.rect(left, y - 2, right - left, 16).fill('#eeeeee').fillColor('black');
  for (const c of cols) pdf.text(c.title, c.x, y + 2, { width: c.w, align: c.align ?? 'left' });
  y += 18;

  pdf.font('Helvetica').fontSize(8);
  for (const d of doc.details) {
    if (y > 700) { pdf.addPage(); y = 50; }
    const valores = [
      d.tipoDoc, d.numDoc, isoDate(d.fechaEmision), d.moneda,
      fmt(d.impTotal), isoDate(d.fecha), fmt(d.importe), fmt(d.neto),
    ];
    cols.forEach((c, i) => pdf.text(valores[i]!, c.x, y, { width: c.w, align: c.align ?? 'left' }));
    y += 14;
  }

  pdf.moveTo(left, y).lineTo(right, y).stroke();
  y += 10;

  pdf.font('Helvetica-Bold').fontSize(9).text(t.total, 330, y, { width: 140, align: 'right' });
  pdf.text(`PEN ${fmt(doc.total)}`, 475, y, { width: 80, align: 'right' });
  y += 15;
  pdf.font('Helvetica').text(t.neto, 330, y, { width: 140, align: 'right' });
  pdf.text(`PEN ${fmt(doc.totalNeto)}`, 475, y, { width: 80, align: 'right' });
  y += 20;

  pdf.font('Helvetica').fontSize(8).text(numeroALetras(doc.total, 'PEN'), left, y, { width: 300 });
  if (doc.observacion) pdf.text(doc.observacion, left, y + 14, { width: 300 });

  const qrY = y + 34;
  pdf.image(qr, left, qrY, { fit: [110, 110] });
  pdf.fontSize(7).text(
    'Representación impresa de un comprobante electrónico. Consulte su validez en www.sunat.gob.pe',
    left + 120, qrY + 10, { width: 300 },
  );

  pdf.end();
  return done;
}
