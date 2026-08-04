import forge from 'node-forge';
import { InvalidTenantInputError } from '../http/errors.ts';

export interface CertificateMaterial {
  privateKeyPem: string;
  certificatePem: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  /** RUC extraído del subject (OID 2.5.4.5 serialNumber), si está presente. */
  ruc?: string;
}

function describe(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value ?? '')}`)
    .join(', ');
}

function fromCertificate(cert: forge.pki.Certificate, privateKeyPem: string): CertificateMaterial {
  const serialField = cert.subject.attributes.find((a) => a.type === '2.5.4.5' || a.shortName === 'serialNumber');
  const rucRaw = serialField?.value ? String(serialField.value) : undefined;
  const ruc = rucRaw ? (/(\d{11})/.exec(rucRaw)?.[1] ?? undefined) : undefined;

  return {
    privateKeyPem,
    certificatePem: forge.pki.certificateToPem(cert),
    subject: describe(cert.subject.attributes),
    issuer: describe(cert.issuer.attributes),
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    ruc,
  };
}

/**
 * Extrae la llave privada y el certificado de un PKCS#12 (.pfx/.p12).
 * Todo ocurre en memoria: nunca se escribe el material criptográfico a disco.
 */
export function parsePfx(pfx: Buffer, password: string): CertificateMaterial {
  // node-forge puede lanzar excepciones propias (no normalizadas) al parsear el
  // DER o abrir el PKCS#12 (contraseña incorrecta, DER corrupto, bytes basura).
  // Se envuelve todo el bloque de apertura para que cualquier fallo se traduzca
  // a un 400 claro, no a un 500 opaco.
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new InvalidTenantInputError('invalid_certificate', 'No se pudo abrir el certificado: contraseña incorrecta o archivo corrupto');
  }

  const keyBags = {
    ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }),
    ...p12.getBags({ bagType: forge.pki.oids.keyBag }),
  };
  const key = Object.values(keyBags).flat().find((b) => b?.key)?.key;
  if (!key) throw new InvalidTenantInputError('invalid_certificate', 'El certificado no contiene una llave privada (¿contraseña incorrecta?)');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certs = Object.values(certBags).flat().map((b) => b?.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (certs.length === 0) throw new InvalidTenantInputError('invalid_certificate', 'El archivo PKCS#12 no contiene certificados');

  // Con cadena de confianza el primer bag es la hoja; se valida contra la llave.
  const publicKeyPem = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey((key as forge.pki.rsa.PrivateKey).n, (key as forge.pki.rsa.PrivateKey).e));
  const leaf = certs.find((c) => forge.pki.publicKeyToPem(c.publicKey) === publicKeyPem) ?? certs[0]!;

  return fromCertificate(leaf, forge.pki.privateKeyToPem(key));
}

/** Lee un PEM que contenga la llave privada y el certificado (en cualquier orden). */
export function parsePem(pem: string): CertificateMaterial {
  const certMatch = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
  const keyMatch = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/.exec(pem);
  if (!certMatch) throw new InvalidTenantInputError('invalid_certificate', 'El PEM no contiene un certificado');
  if (!keyMatch) throw new InvalidTenantInputError('invalid_certificate', 'El PEM no contiene una llave privada');
  const cert = forge.pki.certificateFromPem(certMatch[0]);
  return fromCertificate(cert, keyMatch[0]);
}

/** Detecta el formato (PEM o PKCS#12) y devuelve el material criptográfico. */
export function loadCertificate(data: Buffer, password?: string): CertificateMaterial {
  const head = data.subarray(0, 40).toString('utf8');
  if (head.includes('-----BEGIN')) return parsePem(data.toString('utf8'));
  return parsePfx(data, password ?? '');
}

/** Genera un certificado autofirmado para pruebas en el ambiente BETA. */
export function generateSelfSignedPfx(ruc: string, razonSocial: string, password: string): { pfx: Buffer; material: CertificateMaterial } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: razonSocial },
    { name: 'countryName', value: 'PE' },
    { name: 'organizationName', value: razonSocial },
    { type: '2.5.4.5', value: ruc },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return {
    pfx: Buffer.from(der, 'binary'),
    material: fromCertificate(cert, forge.pki.privateKeyToPem(keys.privateKey)),
  };
}
