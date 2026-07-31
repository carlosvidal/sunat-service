import { query } from '../db/pool.ts';
import { getVault } from '../security/secrets.ts';
import { getStorage, certificateKey } from '../storage/index.ts';
import { loadCertificate, type CertificateMaterial } from '../security/certificate.ts';
import type { Ambiente } from '../sunat/endpoints.ts';
import type { AddressInput, CompanyInput } from '../domain/schemas.ts';

export interface TenantRow {
  tenant_id: string;
  ruc: string;
  razon_social: string;
  nombre_comercial: string | null;
  domicilio_fiscal: AddressInput;
  sol_user: string;
  sol_pass_encrypted: string;
  cert_blob_path: string;
  cert_password_encrypted: string;
  cert_valid_to: Date | null;
  cert_subject: string | null;
  client_id_encrypted: string | null;
  client_secret_encrypted: string | null;
  ambiente: Ambiente;
  webhook_url: string | null;
  webhook_secret: string | null;
  activo: boolean;
  operator_id: string | null;
}

export interface TenantInput {
  tenantId: string;
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  domicilioFiscal: AddressInput;
  solUser: string;
  solPass: string;
  /** Certificado .pfx/.p12 o PEM en base64. */
  certificado: string;
  certPassword?: string;
  clientId?: string;
  clientSecret?: string;
  ambiente: Ambiente;
  webhookUrl?: string;
  webhookSecret?: string;
  /** Operador al que pertenece la empresa (alta). Opcional: operadores huérfanos. */
  operatorId?: string | null;
}

/** Datos públicos de una empresa (nunca incluye secretos). */
export function toPublic(row: TenantRow) {
  return {
    tenant_id: row.tenant_id,
    ruc: row.ruc,
    razon_social: row.razon_social,
    nombre_comercial: row.nombre_comercial,
    domicilio_fiscal: row.domicilio_fiscal,
    sol_user: row.sol_user,
    ambiente: row.ambiente,
    certificado: {
      subject: row.cert_subject,
      valido_hasta: row.cert_valid_to,
      vencido: row.cert_valid_to ? row.cert_valid_to.getTime() < Date.now() : null,
    },
    webhook_url: row.webhook_url,
    activo: row.activo,
    operator_id: row.operator_id,
  };
}

export function companyOf(row: TenantRow): CompanyInput {
  return {
    ruc: row.ruc,
    razonSocial: row.razon_social,
    nombreComercial: row.nombre_comercial ?? undefined,
    address: row.domicilio_fiscal,
  };
}

export async function upsertTenant(input: TenantInput): Promise<TenantRow> {
  const vault = getVault();
  const storage = getStorage();

  const certBuffer = Buffer.from(input.certificado, 'base64');
  // Se valida el certificado antes de persistirlo: si no abre, no sirve.
  const material = loadCertificate(certBuffer, input.certPassword);
  if (material.ruc && material.ruc !== input.ruc) {
    throw new Error(`El certificado pertenece al RUC ${material.ruc}, no a ${input.ruc}`);
  }

  const certPath = certificateKey(input.tenantId);
  await storage.put(certPath, Buffer.from(await vault.encrypt(certBuffer)));

  const { rows } = await query<TenantRow>(
    `INSERT INTO tenant_sunat_profiles (
        tenant_id, ruc, razon_social, nombre_comercial, domicilio_fiscal,
        sol_user, sol_pass_encrypted, cert_blob_path, cert_password_encrypted,
        cert_valid_to, cert_subject, client_id_encrypted, client_secret_encrypted,
        ambiente, webhook_url, webhook_secret, operator_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (tenant_id) DO UPDATE SET
        ruc = EXCLUDED.ruc,
        razon_social = EXCLUDED.razon_social,
        nombre_comercial = EXCLUDED.nombre_comercial,
        domicilio_fiscal = EXCLUDED.domicilio_fiscal,
        sol_user = EXCLUDED.sol_user,
        sol_pass_encrypted = EXCLUDED.sol_pass_encrypted,
        cert_blob_path = EXCLUDED.cert_blob_path,
        cert_password_encrypted = EXCLUDED.cert_password_encrypted,
        cert_valid_to = EXCLUDED.cert_valid_to,
        cert_subject = EXCLUDED.cert_subject,
        client_id_encrypted = EXCLUDED.client_id_encrypted,
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
        ambiente = EXCLUDED.ambiente,
        webhook_url = EXCLUDED.webhook_url,
        webhook_secret = EXCLUDED.webhook_secret,
        updated_at = NOW()
        -- operator_id NO se sobrescribe aquí: se preserva el existente para
        -- evitar que un operador "robe" una empresa mandando un tenant_id ajeno.
        -- La reasignación intencional se hace por ruta de super-admin.
     RETURNING *`,
    [
      input.tenantId,
      input.ruc,
      input.razonSocial,
      input.nombreComercial ?? null,
      JSON.stringify(input.domicilioFiscal),
      input.solUser,
      await vault.encrypt(input.solPass),
      certPath,
      await vault.encrypt(input.certPassword ?? ''),
      material.validTo,
      material.subject,
      input.clientId ? await vault.encrypt(input.clientId) : null,
      input.clientSecret ? await vault.encrypt(input.clientSecret) : null,
      input.ambiente,
      input.webhookUrl ?? null,
      input.webhookSecret ?? null,
      input.operatorId ?? null,
    ],
  );
  return rows[0]!;
}

export async function findTenant(tenantId: string): Promise<TenantRow | null> {
  const { rows } = await query<TenantRow>('SELECT * FROM tenant_sunat_profiles WHERE tenant_id = $1', [tenantId]);
  return rows[0] ?? null;
}

export async function findTenantByRuc(ruc: string): Promise<TenantRow | null> {
  const { rows } = await query<TenantRow>('SELECT * FROM tenant_sunat_profiles WHERE ruc = $1', [ruc]);
  return rows[0] ?? null;
}

export async function listTenants(): Promise<TenantRow[]> {
  const { rows } = await query<TenantRow>('SELECT * FROM tenant_sunat_profiles ORDER BY created_at DESC');
  return rows;
}

/** Empresas que pertenecen a un operador (incluye las huérfanas si operatorId es null). */
export async function listTenantsByOperator(operatorId: string): Promise<TenantRow[]> {
  const { rows } = await query<TenantRow>(
    'SELECT * FROM tenant_sunat_profiles WHERE operator_id = $1 ORDER BY created_at DESC',
    [operatorId],
  );
  return rows;
}

export async function deleteTenant(tenantId: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM tenant_sunat_profiles WHERE tenant_id = $1', [tenantId]);
  return (rowCount ?? 0) > 0;
}

export interface TenantSecrets {
  solPass: string;
  certificate: CertificateMaterial;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Descifra las credenciales del tenant en memoria. El material criptográfico
 * queda únicamente en el heap del proceso que emite y se descarta al terminar
 * el job (nunca se escribe a disco ni se cachea entre tenants).
 */
export async function loadSecrets(row: TenantRow): Promise<TenantSecrets> {
  const vault = getVault();
  const storage = getStorage();
  const encrypted = (await storage.get(row.cert_blob_path)).toString('utf8');
  const pfx = await vault.decrypt(encrypted);
  const certPassword = (await vault.decrypt(row.cert_password_encrypted)).toString('utf8');
  return {
    solPass: (await vault.decrypt(row.sol_pass_encrypted)).toString('utf8'),
    certificate: loadCertificate(pfx, certPassword),
    clientId: row.client_id_encrypted ? (await vault.decrypt(row.client_id_encrypted)).toString('utf8') : undefined,
    clientSecret: row.client_secret_encrypted ? (await vault.decrypt(row.client_secret_encrypted)).toString('utf8') : undefined,
  };
}
