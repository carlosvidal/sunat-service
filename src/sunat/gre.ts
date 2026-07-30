import { createHash } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.ts';
import { ENDPOINTS, type Ambiente } from './endpoints.ts';
import { SunatError, SunatTransportError } from './errors.ts';

export interface GreCredentials {
  ruc: string;
  solUser: string;
  solPass: string;
  /** Credenciales de la API generadas en el portal SOL (menú "Credenciales de API"). */
  clientId: string;
  clientSecret: string;
}

export interface GreSendResult {
  numTicket: string;
}

export interface GreTicketResult {
  codRespuesta?: string;
  indCdrGenerado?: string;
  /** CDR en .zip (base64) cuando SUNAT ya la generó. */
  arcCdr?: string;
  error?: { numError?: string; desError?: string };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Cliente de la API REST de la nueva Guía de Remisión Electrónica (GRE).
 * A diferencia del resto de CPE, no usa SOAP sino OAuth2 + JSON.
 */
export class GreRestClient {
  private readonly ambiente: Ambiente;
  private readonly creds: GreCredentials;

  constructor(ambiente: Ambiente, creds: GreCredentials) {
    this.ambiente = ambiente;
    this.creds = creds;
  }

  /** Token OAuth2 (client_credentials). Se cachea hasta 60 s antes de expirar. */
  async token(): Promise<string> {
    const key = `${this.ambiente}:${this.creds.clientId}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const url = `${ENDPOINTS[this.ambiente].greToken}/${this.creds.clientId}/oauth2/token/`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api-cpe.sunat.gob.pe',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    }).toString();

    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      headersTimeout: config.sunat.timeoutMs,
      bodyTimeout: config.sunat.timeoutMs,
    }).catch((err) => {
      throw new SunatTransportError(`No se pudo obtener el token GRE: ${(err as Error).message}`, err);
    });

    const text = await res.body.text();
    if (res.statusCode >= 300) {
      throw new SunatError('0100', `SUNAT rechazó las credenciales de API GRE (HTTP ${res.statusCode}): ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SunatTransportError('SUNAT no devolvió access_token');

    tokenCache.set(key, {
      token: json.access_token,
      expiresAt: Date.now() + Math.max(30, (json.expires_in ?? 3600) - 60) * 1000,
    });
    return json.access_token;
  }

  /** Envía el .zip de la guía. Devuelve el ticket a consultar. */
  async send(fileName: string, zip: Buffer): Promise<GreSendResult> {
    const url = `${ENDPOINTS[this.ambiente].gre}/comprobantes/${fileName}`;
    const payload = {
      archivo: {
        nomArchivo: `${fileName}.zip`,
        arcGreZip: zip.toString('base64'),
        hashZip: createHash('sha256').update(zip).digest('hex'),
      },
    };
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.token()}` },
      body: JSON.stringify(payload),
      headersTimeout: config.sunat.timeoutMs,
      bodyTimeout: config.sunat.timeoutMs,
    }).catch((err) => {
      throw new SunatTransportError(`No se pudo enviar la guía a SUNAT: ${(err as Error).message}`, err);
    });

    const text = await res.body.text();
    if (res.statusCode >= 300) {
      const parsed = safeJson(text);
      const cod = String(parsed?.cod ?? parsed?.codigo ?? res.statusCode);
      const msg = String(parsed?.msg ?? parsed?.mensaje ?? text.slice(0, 300));
      throw new SunatError(cod, msg);
    }
    const json = safeJson(text);
    const ticket = json?.numTicket ?? json?.numticket;
    if (!ticket) throw new SunatTransportError(`SUNAT no devolvió numTicket: ${text.slice(0, 200)}`);
    return { numTicket: String(ticket) };
  }

  /** Consulta el ticket de una guía enviada. */
  async status(ticket: string): Promise<GreTicketResult> {
    const url = `${ENDPOINTS[this.ambiente].gre}/comprobantes/envios/${ticket}`;
    const res = await request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${await this.token()}` },
      headersTimeout: config.sunat.timeoutMs,
      bodyTimeout: config.sunat.timeoutMs,
    }).catch((err) => {
      throw new SunatTransportError(`No se pudo consultar el ticket GRE: ${(err as Error).message}`, err);
    });
    const text = await res.body.text();
    if (res.statusCode >= 300) {
      throw new SunatError(String(res.statusCode), text.slice(0, 300));
    }
    return (safeJson(text) ?? {}) as unknown as GreTicketResult;
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
