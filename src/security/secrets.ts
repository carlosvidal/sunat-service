import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Bóveda de secretos. La interfaz permite cambiar de un cifrado local
 * (AES-256-GCM con clave maestra en variable de entorno) a AWS KMS o Vault
 * sin tocar el resto del servicio.
 */
export interface SecretVault {
  encrypt(plaintext: Buffer | string): Promise<string>;
  decrypt(ciphertext: string): Promise<Buffer>;
}

const VERSION = 'v1';

export class LocalAesVault implements SecretVault {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    if (!masterKey) {
      throw new Error('SECRETS_MASTER_KEY es obligatorio (32 bytes en base64: openssl rand -base64 32)');
    }
    const raw = Buffer.from(masterKey, 'base64');
    // Se acepta cualquier longitud derivando una clave de 32 bytes con SHA-256.
    this.key = raw.length === 32 ? raw : createHash('sha256').update(masterKey).digest();
  }

  async encrypt(plaintext: Buffer | string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(plaintext as Buffer)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    const [version, ivB64, tagB64, dataB64] = ciphertext.split('.');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Secreto cifrado con un formato desconocido');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  }
}

/**
 * Cifrado sobre KMS: se pide una data key a KMS y se usa localmente
 * (envelope encryption). Se deja como punto de extensión explícito para no
 * arrastrar el SDK de AWS en el despliegue por defecto.
 */
export class KmsVault implements SecretVault {
  private readonly keyId: string;
  private readonly region: string;

  constructor(keyId: string, region: string) {
    this.keyId = keyId;
    this.region = region;
  }

  async encrypt(): Promise<string> {
    throw new Error(
      `KmsVault no implementado. Instale @aws-sdk/client-kms y complete encrypt() usando la llave ${this.keyId} en ${this.region}.`,
    );
  }

  async decrypt(): Promise<Buffer> {
    throw new Error('KmsVault no implementado.');
  }
}

let vault: SecretVault | undefined;

export function getVault(): SecretVault {
  if (!vault) {
    vault = config.secrets.driver === 'kms'
      ? new KmsVault(config.secrets.kmsKeyId, config.secrets.awsRegion)
      : new LocalAesVault(config.secrets.masterKey);
  }
  return vault;
}
