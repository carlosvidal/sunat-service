import { request } from 'undici';
import { config } from '../config.ts';
import { endpointFor, type Ambiente } from './endpoints.ts';
import { SunatError, SunatTransportError } from './errors.ts';
import { parseCdrZip, type CdrResponse } from './cdr.ts';

export interface SolCredentials {
  ruc: string;
  /** Usuario secundario SOL (sin el RUC). */
  solUser: string;
  solPass: string;
}

export interface SendBillResult {
  cdr: CdrResponse;
  cdrZip: Buffer;
}

export interface StatusResult {
  /** 0 = procesado; 98 = en proceso; 99 = procesado con errores. */
  statusCode: string;
  cdr?: CdrResponse;
  cdrZip?: Buffer;
}

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

function envelope(creds: SolCredentials, body: string): string {
  const username = `${creds.ruc}${creds.solUser}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
<soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${escapeXml(username)}</wsse:Username><wsse:Password>${escapeXml(creds.solPass)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>
<soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

function extract(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  return re.exec(xml)?.[1];
}

function throwIfFault(xml: string): void {
  if (!/<(?:[\w-]+:)?Fault[\s>]/i.test(xml)) return;
  const faultCode = extract(xml, 'faultcode')?.trim() ?? '';
  const faultString = (extract(xml, 'faultstring') ?? 'Error SOAP sin descripción').trim();
  // faultcode viene como "soap-env:Client.2033"; interesa la parte numérica.
  const code = /(\d{3,4})/.exec(faultCode)?.[1] ?? /(\d{3,4})/.exec(faultString)?.[1] ?? '0000';
  throw new SunatError(code, faultString);
}

async function post(url: string, soapBody: string): Promise<string> {
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
      body: soapBody,
      headersTimeout: config.sunat.timeoutMs,
      bodyTimeout: config.sunat.timeoutMs,
    });
    const text = await res.body.text();
    if (res.statusCode >= 500) {
      // Un 500 de SUNAT puede traer un Fault legítimo en el cuerpo.
      throwIfFault(text);
      throw new SunatTransportError(`SUNAT respondió HTTP ${res.statusCode}`);
    }
    if (res.statusCode >= 400) {
      throwIfFault(text);
      throw new SunatTransportError(`SUNAT respondió HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    throwIfFault(text);
    return text;
  } catch (err) {
    if (err instanceof SunatError || err instanceof SunatTransportError) throw err;
    throw new SunatTransportError(`No se pudo contactar a SUNAT: ${(err as Error).message}`, err);
  }
}

export class SunatSoapClient {
  private readonly ambiente: Ambiente;
  private readonly creds: SolCredentials;

  constructor(ambiente: Ambiente, creds: SolCredentials) {
    this.ambiente = ambiente;
    this.creds = creds;
  }

  private url(servicio: 'cpe' | 'otros' | 'consulta'): string {
    return endpointFor(this.ambiente, servicio);
  }

  /** sendBill: envío síncrono de facturas, boletas y notas. Devuelve la CDR. */
  async sendBill(fileName: string, zip: Buffer, servicio: 'cpe' | 'otros' = 'cpe'): Promise<SendBillResult> {
    const body = `<ser:sendBill><fileName>${escapeXml(`${fileName}.zip`)}</fileName><contentFile>${zip.toString('base64')}</contentFile></ser:sendBill>`;
    const xml = await post(this.url(servicio), envelope(this.creds, body));
    const b64 = extract(xml, 'applicationResponse');
    if (!b64) throw new SunatTransportError('SUNAT no devolvió applicationResponse');
    const cdrZip = Buffer.from(b64.trim(), 'base64');
    return { cdr: await parseCdrZip(cdrZip), cdrZip };
  }

  /** sendSummary: envío asíncrono de resúmenes diarios y bajas. Devuelve un ticket. */
  async sendSummary(fileName: string, zip: Buffer, servicio: 'cpe' | 'otros' = 'cpe'): Promise<string> {
    const body = `<ser:sendSummary><fileName>${escapeXml(`${fileName}.zip`)}</fileName><contentFile>${zip.toString('base64')}</contentFile></ser:sendSummary>`;
    const xml = await post(this.url(servicio), envelope(this.creds, body));
    const ticket = extract(xml, 'ticket')?.trim();
    if (!ticket) throw new SunatTransportError('SUNAT no devolvió ticket');
    return ticket;
  }

  /** getStatus: consulta el resultado de un ticket. */
  async getStatus(ticket: string, servicio: 'cpe' | 'otros' = 'cpe'): Promise<StatusResult> {
    const body = `<ser:getStatus><ticket>${escapeXml(ticket)}</ticket></ser:getStatus>`;
    const xml = await post(this.url(servicio), envelope(this.creds, body));
    const statusCode = extract(xml, 'statusCode')?.trim() ?? '';
    const content = extract(xml, 'content')?.trim();
    if (!content) return { statusCode };
    const cdrZip = Buffer.from(content, 'base64');
    return { statusCode, cdrZip, cdr: await parseCdrZip(cdrZip) };
  }

  /**
   * getStatusCdr: recupera la CDR de un comprobante ya enviado
   * (servicio de consulta, requiere que el usuario SOL tenga el permiso).
   */
  async getStatusCdr(tipoDoc: string, serie: string, correlativo: string): Promise<StatusResult> {
    const body = `<ser:getStatusCdr><rucComprobante>${escapeXml(this.creds.ruc)}</rucComprobante><tipoComprobante>${escapeXml(tipoDoc)}</tipoComprobante><serieComprobante>${escapeXml(serie)}</serieComprobante><numeroComprobante>${escapeXml(correlativo)}</numeroComprobante></ser:getStatusCdr>`;
    const xml = await post(this.url('consulta'), envelope(this.creds, body));
    const statusCode = extract(xml, 'statusCode')?.trim() ?? '';
    const content = extract(xml, 'content')?.trim();
    if (!content) {
      const message = extract(xml, 'statusMessage')?.trim() ?? '';
      return { statusCode, cdr: { accepted: false, severity: 'error', id: `${serie}-${correlativo}`, code: statusCode, description: message, notes: [] } };
    }
    const cdrZip = Buffer.from(content, 'base64');
    return { statusCode, cdrZip, cdr: await parseCdrZip(cdrZip) };
  }
}
