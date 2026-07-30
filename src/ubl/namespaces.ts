export const NS = {
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  sac: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1',
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  debitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  summary: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  voided: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
} as const;

/** Id del nodo ds:Signature referenciado desde cac:DigitalSignatureAttachment. */
export const SIGNATURE_ID = 'SIGN-MITIENDA';
