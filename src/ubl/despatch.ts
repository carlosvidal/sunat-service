import { create } from 'xmlbuilder2';
import type { XB } from './xb.ts';
import { NS } from './namespaces.ts';
import { addSignature, addUblExtensions, cac, cbc, cbcCdata } from './common.ts';
import type { DespatchInput, ClientInput, CompanyInput } from '../domain/schemas.ts';
import { fmt, fmtLimit } from '../util/money.ts';
import { isoDate, isoTime } from '../util/dates.ts';

export type DespatchDoc = Omit<DespatchInput, 'company'> & {
  company: CompanyInput;
  correlativo: string;
  fechaEmision: string;
};

const CAT06 = {
  schemeName: 'Documento de Identidad',
  schemeAgencyName: 'PE:SUNAT',
  schemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
};

function addParty(root: XB, tag: string, person: ClientInput): void {
  const party = cac(cac(root, tag), 'Party');
  cbc(cac(party, 'PartyIdentification'), 'ID', person.numDoc, { schemeID: person.tipoDoc, ...CAT06 });
  cbcCdata(cac(party, 'PartyLegalEntity'), 'RegistrationName', person.rznSocial);
}

/**
 * Guía de Remisión Electrónica (DespatchAdvice UBL 2.1, versión 2022).
 * Se transmite por la API REST de SUNAT, no por el web service SOAP.
 */
export function buildDespatchXml(doc: DespatchDoc): string {
  const envio = doc.envio;
  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele('urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2', 'DespatchAdvice')
    .att('xmlns:cac', NS.cac)
    .att('xmlns:cbc', NS.cbc)
    .att('xmlns:ds', NS.ds)
    .att('xmlns:ext', NS.ext);

  addUblExtensions(root);
  cbc(root, 'UBLVersionID', '2.1');
  cbc(root, 'CustomizationID', '2.0');
  cbc(root, 'ID', `${doc.serie}-${doc.correlativo}`);
  cbc(root, 'IssueDate', isoDate(doc.fechaEmision));
  cbc(root, 'IssueTime', isoTime(doc.fechaEmision));
  cbc(root, 'DespatchAdviceTypeCode', doc.tipoDoc, {
    listAgencyName: 'PE:SUNAT',
    listName: 'Tipo de Documento',
    listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01',
  });
  if (doc.observacion) cbcCdata(root, 'Note', doc.observacion);

  if (doc.docBaja) {
    const ref = cac(cac(root, 'OrderReference'), 'DocumentReference');
    cbc(ref, 'ID', doc.docBaja.nroDoc);
    cbc(ref, 'DocumentTypeCode', doc.docBaja.tipoDoc);
  }
  if (doc.relDoc) {
    const node = cac(root, 'AdditionalDocumentReference');
    cbc(node, 'ID', doc.relDoc.nroDoc);
    cbc(node, 'DocumentTypeCode', doc.relDoc.tipoDoc, {
      listAgencyName: 'PE:SUNAT',
      listName: 'Documento relacionado al transporte',
      listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61',
    });
  }
  for (const add of doc.addDocs ?? []) {
    const node = cac(root, 'AdditionalDocumentReference');
    cbc(node, 'ID', add.nro);
    cbc(node, 'DocumentTypeCode', add.tipo, {
      listAgencyName: 'PE:SUNAT',
      listName: 'Documento relacionado al transporte',
      listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61',
    });
    if (add.tipoDesc) cbc(node, 'DocumentType', add.tipoDesc);
    if (add.emisor) {
      const issuer = cac(node, 'IssuerParty');
      cbc(cac(issuer, 'PartyIdentification'), 'ID', add.emisor, { schemeID: '6', ...CAT06 });
    }
  }

  addSignature(root, doc.company);

  const supplier = cac(cac(root, 'DespatchSupplierParty'), 'Party');
  cbc(cac(supplier, 'PartyIdentification'), 'ID', doc.company.ruc, { schemeID: '6', ...CAT06 });
  cbcCdata(cac(supplier, 'PartyLegalEntity'), 'RegistrationName', doc.company.razonSocial);

  addParty(root, 'DeliveryCustomerParty', doc.destinatario);
  if (doc.comprador) addParty(root, 'BuyerCustomerParty', doc.comprador);
  if (doc.tercero) addParty(root, 'SellerSupplierParty', doc.tercero);

  const shipment = cac(root, 'Shipment');
  cbc(shipment, 'ID', 'SUNAT_Envio');
  cbc(shipment, 'HandlingCode', envio.codTraslado, {
    listAgencyName: 'PE:SUNAT',
    listName: 'Motivo de traslado',
    listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20',
  });
  if (envio.desTraslado) cbc(shipment, 'HandlingInstructions', envio.desTraslado);
  if (envio.sustentoPeso) cbc(shipment, 'Information', envio.sustentoPeso);
  cbc(shipment, 'GrossWeightMeasure', fmt(envio.pesoTotal, 3), { unitCode: envio.undPesoTotal });
  if (envio.pesoItems !== undefined) cbc(shipment, 'NetWeightMeasure', fmt(envio.pesoItems, 3), { unitCode: 'KGM' });
  if (envio.numBultos !== undefined) cbc(shipment, 'TotalTransportHandlingUnitQuantity', envio.numBultos);
  for (const indicador of envio.indicadores ?? []) cbc(shipment, 'SpecialInstructions', indicador);

  const stage = cac(shipment, 'ShipmentStage');
  cbc(stage, 'TransportModeCode', envio.modTraslado, {
    listName: 'Modalidad de traslado',
    listAgencyName: 'PE:SUNAT',
    listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18',
  });
  cbc(cac(stage, 'TransitPeriod'), 'StartDate', isoDate(envio.fecTraslado));
  if (envio.transportista) {
    const carrier = cac(stage, 'CarrierParty');
    cbc(cac(carrier, 'PartyIdentification'), 'ID', envio.transportista.numDoc, { schemeID: envio.transportista.tipoDoc });
    const legal = cac(carrier, 'PartyLegalEntity');
    cbcCdata(legal, 'RegistrationName', envio.transportista.rznSocial);
    if (envio.transportista.nroMtc) cbc(legal, 'CompanyID', envio.transportista.nroMtc);
  }
  if (envio.fecEntregaBienes) {
    cbc(cac(stage, 'LoadingTransportEvent'), 'OccurrenceDate', isoDate(envio.fecEntregaBienes));
  }
  for (const chofer of envio.choferes ?? []) {
    const driver = cac(stage, 'DriverPerson');
    cbc(driver, 'ID', chofer.nroDoc, { schemeID: chofer.tipoDoc, ...CAT06 });
    cbc(driver, 'FirstName', chofer.nombres);
    cbc(driver, 'FamilyName', chofer.apellidos);
    cbc(driver, 'JobTitle', chofer.tipo);
    cbc(cac(driver, 'IdentityDocumentReference'), 'ID', chofer.licencia);
  }

  const delivery = cac(shipment, 'Delivery');
  const llegada = cac(delivery, 'DeliveryAddress');
  cbc(llegada, 'ID', envio.llegada.ubigueo, { schemeAgencyName: 'PE:INEI', schemeName: 'Ubigeos' });
  if (envio.llegada.codLocal) {
    cbc(llegada, 'AddressTypeCode', envio.llegada.codLocal, { listID: envio.llegada.ruc ?? doc.company.ruc });
  }
  cbc(cac(llegada, 'AddressLine'), 'Line', envio.llegada.direccion);

  const partida = cac(cac(delivery, 'Despatch'), 'DespatchAddress');
  cbc(partida, 'ID', envio.partida.ubigueo, { schemeAgencyName: 'PE:INEI', schemeName: 'Ubigeos' });
  if (envio.partida.codLocal) {
    cbc(partida, 'AddressTypeCode', envio.partida.codLocal, { listID: envio.partida.ruc ?? doc.company.ruc });
  }
  cbc(cac(partida, 'AddressLine'), 'Line', envio.partida.direccion);

  (envio.contenedores ?? []).forEach((precinto, i) => {
    const unit = cac(shipment, 'TransportHandlingUnit');
    const pkg = cac(unit, 'Package');
    cbc(pkg, 'ID', String(i + 1));
    cbc(pkg, 'TraceID', precinto);
  });

  if (envio.vehiculo) {
    const unit = cac(shipment, 'TransportHandlingUnit');
    const equipment = cac(unit, 'TransportEquipment');
    cbc(equipment, 'ID', envio.vehiculo.placa);
    if (envio.vehiculo.nroCirculacion) {
      cbc(cac(equipment, 'ApplicableTransportMeans'), 'RegistrationNationalityID', envio.vehiculo.nroCirculacion);
    }
    for (const sec of (envio.vehiculo.secundarios ?? []) as Array<{ placa: string; nroCirculacion?: string; nroAutorizacion?: string; codEmisor?: string }>) {
      const attached = cac(equipment, 'AttachedTransportEquipment');
      cbc(attached, 'ID', sec.placa);
      if (sec.nroCirculacion) {
        cbc(cac(attached, 'ApplicableTransportMeans'), 'RegistrationNationalityID', sec.nroCirculacion);
      }
      if (sec.nroAutorizacion) {
        cbc(cac(attached, 'ShipmentDocumentReference'), 'ID', sec.nroAutorizacion, {
          schemeID: sec.codEmisor ?? '', schemeName: 'Entidad Autorizadora', schemeAgencyName: 'PE:SUNAT',
        });
      }
    }
    if (envio.vehiculo.nroAutorizacion) {
      cbc(cac(equipment, 'ShipmentDocumentReference'), 'ID', envio.vehiculo.nroAutorizacion, {
        schemeID: envio.vehiculo.codEmisor ?? '', schemeName: 'Entidad Autorizadora', schemeAgencyName: 'PE:SUNAT',
      });
    }
  }

  const puerto = envio.puerto ?? envio.aeropuerto;
  if (puerto) {
    const esPuerto = Boolean(envio.puerto);
    const node = cac(shipment, 'FirstArrivalPortLocation');
    cbc(node, 'ID', puerto.codigo, {
      schemeAgencyName: 'PE:SUNAT',
      schemeName: esPuerto ? 'Puertos' : 'Aeropuertos',
      schemeURI: `urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo${esPuerto ? '63' : '64'}`,
    });
    cbc(node, 'LocationTypeCode', esPuerto ? '1' : '2');
    cbc(node, 'Name', puerto.nombre);
  }

  doc.details.forEach((det, i) => {
    const line = cac(root, 'DespatchLine');
    cbc(line, 'ID', String(i + 1));
    cbc(line, 'DeliveredQuantity', fmtLimit(det.cantidad, 10), { unitCode: det.unidad });
    cbc(cac(line, 'OrderLineReference'), 'LineID', String(i + 1));
    const item = cac(line, 'Item');
    cbcCdata(item, 'Description', det.descripcion);
    cbc(cac(item, 'SellersItemIdentification'), 'ID', det.codigo ?? String(i + 1));
    if (det.codProdSunat) {
      cbc(cac(item, 'CommodityClassification'), 'ItemClassificationCode', det.codProdSunat, {
        listID: 'UNSPSC', listAgencyName: 'GS1 US', listName: 'Item Classification',
      });
    }
    for (const atr of det.atributos ?? []) {
      const prop = cac(item, 'AdditionalItemProperty');
      cbc(prop, 'Name', atr.name);
      cbc(prop, 'NameCode', atr.code);
      if (atr.value !== undefined) cbc(prop, 'Value', atr.value);
    }
  });

  return root.end({ prettyPrint: false });
}
