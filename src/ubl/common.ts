import type { XB as XMLBuilder } from './xb.ts';
import { NS, SIGNATURE_ID } from './namespaces.ts';
import type { AddressInput, ClientInput, CompanyInput } from '../domain/schemas.ts';
import { fmt } from '../util/money.ts';
import type { Tributo } from '../domain/catalogs.ts';

export function cbc(parent: XMLBuilder, name: string, value: string | number, attrs?: Record<string, string>): XMLBuilder {
  const node = parent.ele(NS.cbc, `cbc:${name}`);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.att(k, v);
  node.txt(String(value));
  return node;
}

/** Igual que cbc() pero envolviendo el texto en CDATA (nombres, descripciones). */
export function cbcCdata(parent: XMLBuilder, name: string, value: string, attrs?: Record<string, string>): XMLBuilder {
  const node = parent.ele(NS.cbc, `cbc:${name}`);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.att(k, v);
  node.dat(value);
  return node;
}

export function cac(parent: XMLBuilder, name: string): XMLBuilder {
  return parent.ele(NS.cac, `cac:${name}`);
}

export function sac(parent: XMLBuilder, name: string): XMLBuilder {
  return parent.ele(NS.sac, `sac:${name}`);
}

/** Bloque ext:UBLExtensions donde se insertará la firma digital. */
export function addUblExtensions(root: XMLBuilder): void {
  root.ele(NS.ext, 'ext:UBLExtensions')
    .ele(NS.ext, 'ext:UBLExtension')
    .ele(NS.ext, 'ext:ExtensionContent');
}

/** cac:Signature: declara quién firma y apunta al nodo ds:Signature. */
export function addSignature(root: XMLBuilder, company: CompanyInput): void {
  const sig = cac(root, 'Signature');
  cbc(sig, 'ID', SIGNATURE_ID);
  const party = cac(sig, 'SignatoryParty');
  cbc(cac(party, 'PartyIdentification'), 'ID', company.ruc);
  cbcCdata(cac(party, 'PartyName'), 'Name', company.razonSocial);
  const attachment = cac(sig, 'DigitalSignatureAttachment');
  cbc(cac(attachment, 'ExternalReference'), 'URI', `#${SIGNATURE_ID}`);
}

function addRegistrationAddress(parent: XMLBuilder, addr: AddressInput, full: boolean): void {
  const node = cac(parent, 'RegistrationAddress');
  if (addr.ubigueo) cbc(node, 'ID', addr.ubigueo);
  if (full) {
    cbc(node, 'AddressTypeCode', addr.codLocal || '0000');
    if (addr.urbanizacion) cbc(node, 'CitySubdivisionName', addr.urbanizacion);
    cbc(node, 'CityName', addr.provincia ?? '');
    cbc(node, 'CountrySubentity', addr.departamento ?? '');
    cbc(node, 'District', addr.distrito ?? '');
  }
  cbcCdata(cac(node, 'AddressLine'), 'Line', addr.direccion ?? '-');
  cbc(cac(node, 'Country'), 'IdentificationCode', addr.codigoPais || 'PE');
}

function addContact(parent: XMLBuilder, email?: string, telephone?: string): void {
  if (!email && !telephone) return;
  const contact = cac(parent, 'Contact');
  if (telephone) cbc(contact, 'Telephone', telephone);
  if (email) cbc(contact, 'ElectronicMail', email);
}

/** cac:AccountingSupplierParty (emisor). */
export function addSupplierParty(root: XMLBuilder, company: CompanyInput): void {
  const party = cac(cac(root, 'AccountingSupplierParty'), 'Party');
  cbc(cac(party, 'PartyIdentification'), 'ID', company.ruc, { schemeID: '6' });
  if (company.nombreComercial) cbcCdata(cac(party, 'PartyName'), 'Name', company.nombreComercial);
  const legal = cac(party, 'PartyLegalEntity');
  cbcCdata(legal, 'RegistrationName', company.razonSocial);
  if (company.address) addRegistrationAddress(legal, company.address, true);
  addContact(party, company.email, company.telephone);
}

/** cac:AccountingCustomerParty o cac:SellerSupplierParty (tercero). */
export function addPersonParty(root: XMLBuilder, tag: string, person: ClientInput): void {
  const party = cac(cac(root, tag), 'Party');
  cbc(cac(party, 'PartyIdentification'), 'ID', person.numDoc, { schemeID: person.tipoDoc });
  const legal = cac(party, 'PartyLegalEntity');
  cbcCdata(legal, 'RegistrationName', person.rznSocial);
  if (person.address) addRegistrationAddress(legal, person.address, false);
  addContact(party, person.email, person.telephone);
}

export interface TaxSubtotalOptions {
  taxableAmount?: number;
  taxAmount: number;
  tributo: Tributo;
  currency: string;
  percent?: number;
  exemptionReasonCode?: string;
  tierRange?: string;
  perUnitAmount?: number;
  baseUnitMeasure?: { value: number; unitCode: string };
}

export function addTaxSubtotal(taxTotal: XMLBuilder, o: TaxSubtotalOptions): void {
  const st = cac(taxTotal, 'TaxSubtotal');
  if (o.taxableAmount !== undefined) cbc(st, 'TaxableAmount', fmt(o.taxableAmount), { currencyID: o.currency });
  cbc(st, 'TaxAmount', fmt(o.taxAmount), { currencyID: o.currency });
  if (o.baseUnitMeasure) {
    cbc(st, 'BaseUnitMeasure', o.baseUnitMeasure.value, { unitCode: o.baseUnitMeasure.unitCode });
  }
  const cat = cac(st, 'TaxCategory');
  if (o.perUnitAmount !== undefined) cbc(cat, 'PerUnitAmount', fmt(o.perUnitAmount), { currencyID: o.currency });
  if (o.percent !== undefined) cbc(cat, 'Percent', fmt(o.percent));
  if (o.tierRange) cbc(cat, 'TierRange', o.tierRange);
  if (o.exemptionReasonCode) cbc(cat, 'TaxExemptionReasonCode', o.exemptionReasonCode);
  const scheme = cac(cat, 'TaxScheme');
  cbc(scheme, 'ID', o.tributo.id);
  cbc(scheme, 'Name', o.tributo.name);
  cbc(scheme, 'TaxTypeCode', o.tributo.code);
}
