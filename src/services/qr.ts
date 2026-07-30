import QRCode from 'qrcode';
import type { SaleDoc } from '../ubl/types.ts';
import { fmt } from '../util/money.ts';
import { isoDate } from '../util/dates.ts';

/**
 * Contenido del código QR normativo:
 * RUC | Tipo | Serie | Número | IGV | Total | Fecha | TipoDocAdquiriente | NroDocAdquiriente | Hash
 */
export function qrText(doc: SaleDoc, digestValue = ''): string {
  return [
    doc.company.ruc,
    doc.tipoDoc,
    doc.serie,
    doc.correlativo,
    fmt(doc.mtoIGV ?? 0),
    fmt(doc.mtoImpVenta ?? 0),
    isoDate(doc.fechaEmision),
    doc.client.tipoDoc,
    doc.client.numDoc,
    digestValue,
  ].join('|');
}

export async function qrPng(text: string, width = 220): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', width, margin: 1, errorCorrectionLevel: 'M' });
}
