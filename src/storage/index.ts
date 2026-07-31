import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.ts';

export interface Storage {
  put(key: string, data: Buffer, contentType?: string): Promise<string>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements Storage {
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private path(key: string): string {
    const full = resolve(this.base, key);
    // Evita path traversal si un tenant_id o nombre de archivo viene manipulado.
    if (!full.startsWith(resolve(this.base))) throw new Error('Ruta de almacenamiento inválida');
    return full;
  }

  async put(key: string, data: Buffer): Promise<string> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}

/** Cliente S3/R2 mínimo con firma SigV4 (sin dependencias del SDK de AWS). */
class S3Storage implements Storage {
  private readonly opts: typeof config.storage.s3;

  constructor(opts: typeof config.storage.s3) {
    if (!opts.bucket) throw new Error('S3_BUCKET es obligatorio con STORAGE_DRIVER=s3');
    this.opts = opts;
  }

  private url(key: string): string {
    const endpoint = this.opts.endpoint || `https://s3.${this.opts.region}.amazonaws.com`;
    const base = endpoint.replace(/\/$/, '');
    return this.opts.forcePathStyle
      ? `${base}/${this.opts.bucket}/${key}`
      : base.replace('://', `://${this.opts.bucket}.`) + `/${key}`;
  }

  private sign(method: string, urlStr: string, payload: Buffer, contentType?: string): Record<string, string> {
    const url = new URL(urlStr);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';
    const region = this.opts.region;
    const payloadHash = createHash('sha256').update(payload).digest('hex');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    };
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<string> {
    const url = this.url(key);
    const res = await request(url, { method: 'PUT', body: data, headers: this.sign('PUT', url, data, contentType) });
    if (res.statusCode >= 300) {
      throw new Error(`S3 PUT ${key} falló (${res.statusCode}): ${(await res.body.text()).slice(0, 300)}`);
    }
    await res.body.dump();
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const url = this.url(key);
    const res = await request(url, { method: 'GET', headers: this.sign('GET', url, Buffer.alloc(0)) });
    if (res.statusCode >= 300) {
      throw new Error(`S3 GET ${key} falló (${res.statusCode})`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }
}

let storage: Storage | undefined;

export function getStorage(): Storage {
  if (!storage) {
    storage = config.storage.driver === 's3'
      ? new S3Storage(config.storage.s3)
      : new LocalStorage(config.storage.localPath);
  }
  return storage;
}

/** Convención de rutas: {ruc}/{yyyy}/{mm}/{nombre}.{ext} */
export function artifactKey(ruc: string, fecha: string, nombre: string, ext: string): string {
  const [year, month] = fecha.split('-');
  return join(ruc, year ?? '0000', month ?? '00', `${nombre}.${ext}`);
}

export function certificateKey(tenantId: string): string {
  return join('certificates', `${tenantId}.pfx.enc`);
}
