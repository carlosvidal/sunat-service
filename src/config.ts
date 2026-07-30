import 'dotenv/config';

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /** Clave maestra de la plataforma para administrar empresas (X-API-Key). */
  masterApiKey: process.env.MASTER_API_KEY ?? '',
  /** Secreto de firma de los JWT por empresa. */
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',

  database: {
    url: process.env.DATABASE_URL ?? '',
    ssl: bool(process.env.DATABASE_SSL),
  },

  redis: {
    url: process.env.REDIS_URL ?? '',
  },

  /** Cifrado de secretos en reposo. driver: local | kms */
  secrets: {
    driver: (process.env.SECRETS_DRIVER ?? 'local') as 'local' | 'kms',
    /** 32 bytes en base64 (openssl rand -base64 32). */
    masterKey: process.env.SECRETS_MASTER_KEY ?? '',
    kmsKeyId: process.env.KMS_KEY_ID ?? '',
    awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  },

  /** Almacenamiento de artefactos. driver: local | s3 */
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localPath: process.env.STORAGE_PATH ?? './storage',
    s3: {
      bucket: process.env.S3_BUCKET ?? '',
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    },
  },

  sunat: {
    timeoutMs: Number(process.env.SUNAT_TIMEOUT_MS ?? 45000),
  },

  /** Webhook global por defecto (puede sobreescribirse por empresa). */
  webhook: {
    url: process.env.WEBHOOK_URL ?? '',
    secret: process.env.WEBHOOK_SECRET ?? '',
  },

  worker: {
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  },
};

export type Config = typeof config;
