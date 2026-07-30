import { SignedXml } from 'xml-crypto';
import { SIGNATURE_ID } from './namespaces.ts';

export interface SignedDocument {
  xml: string;
  /** DigestValue de la referencia — es el "hash" que SUNAT usa como resumen del CPE. */
  digestValue: string;
  signatureValue: string;
}

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * Firma un XML UBL con XMLDSig (RSA-SHA256, firma envolvente) e inserta el
 * nodo ds:Signature dentro de ext:ExtensionContent, como exige SUNAT.
 */
export function signUbl(xml: string, privateKeyPem: string, certificatePem: string): SignedDocument {
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: '/*',
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA256,
    uri: '',
    isEmptyUri: true,
  });

  sig.computeSignature(xml, {
    prefix: 'ds',
    attrs: { Id: SIGNATURE_ID },
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: 'append' },
  });

  const signed = sig.getSignedXml();
  const digestValue = /<ds:DigestValue>([^<]*)<\/ds:DigestValue>/.exec(signed)?.[1] ?? '';
  const signatureValue = /<ds:SignatureValue>([\s\S]*?)<\/ds:SignatureValue>/.exec(signed)?.[1]?.replace(/\s+/g, '') ?? '';

  return { xml: signed, digestValue, signatureValue };
}
