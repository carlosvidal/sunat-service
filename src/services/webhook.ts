import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.ts';
import type { TenantRow } from '../repositories/tenants.ts';

export interface WebhookEvent {
  event: 'cpe.aceptado' | 'cpe.rechazado' | 'cpe.excepcion' | 'resumen.procesado';
  tenant_id: string;
  ruc: string;
  document_id?: string;
  ticket?: string;
  comprobante?: string;
  state: string;
  code?: string;
  description?: string;
  notes?: string[];
}

/**
 * Notifica al backend del SaaS. La firma HMAC-SHA256 del cuerpo va en
 * `X-Signature` para que el receptor pueda verificar el origen.
 */
export async function notify(tenant: TenantRow, event: WebhookEvent): Promise<void> {
  const url = tenant.webhook_url ?? config.webhook.url;
  if (!url) return;
  const secret = tenant.webhook_secret ?? config.webhook.secret;
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-signature'] = createHmac('sha256', secret).update(body).digest('hex');

  const res = await request(url, { method: 'POST', body, headers, headersTimeout: 10_000, bodyTimeout: 10_000 });
  await res.body.dump();
  if (res.statusCode >= 300) {
    throw new Error(`Webhook ${url} respondió ${res.statusCode}`);
  }
}
