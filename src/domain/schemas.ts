import { z } from 'zod';

/**
 * Esquemas de entrada compatibles con el formato Greenter / APIsPERU.
 * Se aceptan números o cadenas en los campos numéricos porque los clientes
 * suelen enviar RUC/DNI como number y los importes como string.
 */

const codigo = z.coerce.string().trim();
const importe = z.coerce.number();

export const addressSchema = z.object({
  ubigueo: codigo.optional(),
  codigoPais: codigo.default('PE'),
  departamento: z.string().optional(),
  provincia: z.string().optional(),
  distrito: z.string().optional(),
  urbanizacion: z.string().optional(),
  direccion: z.string().optional(),
  codLocal: codigo.default('0000'),
});

export const clientSchema = z.object({
  tipoDoc: codigo,
  numDoc: codigo,
  rznSocial: z.string(),
  address: addressSchema.optional(),
  email: z.string().optional(),
  telephone: z.string().optional(),
});

/** Datos del emisor. Si se omiten se toman del perfil de la empresa (tenant). */
export const companySchema = z.object({
  ruc: codigo,
  razonSocial: z.string(),
  nombreComercial: z.string().optional(),
  address: addressSchema.optional(),
  email: z.string().optional(),
  telephone: z.string().optional(),
});

export const legendSchema = z.object({
  code: codigo,
  value: z.string(),
});

export const documentSchema = z.object({
  tipoDoc: codigo,
  nroDoc: codigo,
});

export const chargeSchema = z.object({
  codTipo: codigo,
  factor: importe.optional(),
  monto: importe,
  montoBase: importe.optional(),
});

export const detailAttributeSchema = z.object({
  code: codigo,
  name: z.string(),
  value: z.string().optional(),
  fecInicio: z.string().optional(),
  fecFin: z.string().optional(),
  duracion: importe.optional(),
});

export const saleDetailSchema = z.object({
  unidad: codigo.default('NIU'),
  cantidad: importe,
  codProducto: codigo.optional(),
  codProdSunat: codigo.optional(),
  codProdGS1: codigo.optional(),
  descripcion: z.string(),
  mtoValorUnitario: importe.optional(),
  descuento: importe.optional(),
  igv: importe.optional(),
  tipAfeIgv: codigo.default('10'),
  isc: importe.optional(),
  tipSisIsc: codigo.optional(),
  totalImpuestos: importe.optional(),
  mtoPrecioUnitario: importe.optional(),
  mtoValorVenta: importe.optional(),
  mtoValorGratuito: importe.optional(),
  mtoBaseIgv: importe.optional(),
  porcentajeIgv: importe.default(18),
  mtoBaseIsc: importe.optional(),
  porcentajeIsc: importe.optional(),
  mtoBaseOth: importe.optional(),
  porcentajeOth: importe.optional(),
  otroTributo: importe.optional(),
  icbper: importe.optional(),
  factorIcbper: importe.optional(),
  cargos: z.array(chargeSchema).optional(),
  descuentos: z.array(chargeSchema).optional(),
  atributos: z.array(detailAttributeSchema).optional(),
});

export const paymentTermsSchema = z.object({
  moneda: codigo.optional(),
  tipo: z.string(),
  monto: importe.optional(),
});

export const cuotaSchema = z.object({
  moneda: codigo.optional(),
  monto: importe,
  fechaPago: z.string(),
});

export const detractionSchema = z.object({
  codBienDetraccion: codigo,
  codMedioPago: codigo,
  ctaBanco: codigo,
  percent: importe,
  mount: importe,
});

export const salePerceptionSchema = z.object({
  codReg: codigo,
  /** Factor, no porcentaje: 0.02 equivale al 2 %. */
  porcentaje: importe,
  mto: importe,
  mtoBase: importe,
  mtoTotal: importe,
});

export const prepaymentSchema = z.object({
  tipoDocRel: codigo,
  nroDocRel: codigo,
  total: importe,
  moneda: codigo.optional(),
});

/** Campos monetarios y de detalle comunes a Factura/Boleta y Notas. */
const saleBase = {
  serie: codigo,
  correlativo: codigo.optional(),
  fechaEmision: z.string().optional(),
  tipoMoneda: codigo.default('PEN'),
  client: clientSchema,
  company: companySchema.optional(),
  ublVersion: codigo.default('2.1'),
  formaPago: paymentTermsSchema.optional(),
  cuotas: z.array(cuotaSchema).optional(),
  details: z.array(saleDetailSchema).min(1),
  legends: z.array(legendSchema).optional(),
  guias: z.array(documentSchema).optional(),
  relDocs: z.array(documentSchema).optional(),
  compra: z.string().optional(),
  observacion: z.string().optional(),

  mtoOperGravadas: importe.optional(),
  mtoOperInafectas: importe.optional(),
  mtoOperExoneradas: importe.optional(),
  mtoOperExportacion: importe.optional(),
  mtoOperGratuitas: importe.optional(),
  mtoIGV: importe.optional(),
  mtoIGVGratuitas: importe.optional(),
  mtoISC: importe.optional(),
  mtoBaseIsc: importe.optional(),
  mtoOtrosTributos: importe.optional(),
  mtoBaseOth: importe.optional(),
  mtoBaseIvap: importe.optional(),
  mtoIvap: importe.optional(),
  icbper: importe.optional(),
  totalImpuestos: importe.optional(),
  valorVenta: importe.optional(),
  subTotal: importe.optional(),
  mtoImpVenta: importe.optional(),
  sumOtrosCargos: importe.optional(),
  sumOtrosDescuentos: importe.optional(),
  redondeo: importe.optional(),
  totalAnticipos: importe.optional(),
  cargos: z.array(chargeSchema).optional(),
  descuentos: z.array(chargeSchema).optional(),
};

export const invoiceSchema = z.object({
  ...saleBase,
  tipoDoc: z.enum(['01', '03']),
  tipoOperacion: codigo.default('0101'),
  fecVencimiento: z.string().optional(),
  detraccion: detractionSchema.optional(),
  perception: salePerceptionSchema.optional(),
  anticipos: z.array(prepaymentSchema).optional(),
  seller: clientSchema.optional(),
  direccionEntrega: addressSchema.optional(),
});

export const noteSchema = z.object({
  ...saleBase,
  tipoDoc: z.enum(['07', '08']),
  tipDocAfectado: codigo,
  numDocfectado: codigo,
  codMotivo: codigo,
  desMotivo: z.string(),
});

export const summaryPerceptionSchema = z.object({
  codReg: codigo,
  tasa: importe,
  mtoBase: importe,
  mto: importe,
  mtoTotal: importe,
});

export const summaryDetailSchema = z.object({
  tipoDoc: codigo,
  serieNro: codigo,
  clienteTipo: codigo.optional(),
  clienteNro: codigo.optional(),
  docReferencia: documentSchema.optional(),
  percepcion: summaryPerceptionSchema.optional(),
  /** Catálogo 19: 1 = adicionar, 2 = modificar, 3 = anulado. */
  estado: codigo.default('1'),
  total: importe,
  porcentajeIgv: importe.optional(),
  mtoOperGravadas: importe.optional(),
  mtoOperInafectas: importe.optional(),
  mtoOperExoneradas: importe.optional(),
  mtoOperExportacion: importe.optional(),
  mtoOperGratuitas: importe.optional(),
  mtoOtrosCargos: importe.optional(),
  mtoIGV: importe.optional(),
  mtoIvap: importe.optional(),
  mtoIcbper: importe.optional(),
  mtoISC: importe.optional(),
  mtoOtrosTributos: importe.optional(),
});

export const summarySchema = z.object({
  correlativo: codigo,
  fecGeneracion: z.string(),
  fecResumen: z.string().optional(),
  moneda: codigo.default('PEN'),
  company: companySchema.optional(),
  details: z.array(summaryDetailSchema).min(1),
});

export const voidedDetailSchema = z.object({
  tipoDoc: codigo,
  serie: codigo,
  correlativo: codigo,
  desMotivoBaja: z.string(),
});

export const voidedSchema = z.object({
  correlativo: codigo,
  fecGeneracion: z.string(),
  fecComunicacion: z.string().optional(),
  company: companySchema.optional(),
  details: z.array(voidedDetailSchema).min(1),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type ClientInput = z.infer<typeof clientSchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type SaleDetailInput = z.infer<typeof saleDetailSchema>;
export type InvoiceInput = z.infer<typeof invoiceSchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type SummaryInput = z.infer<typeof summarySchema>;
export type VoidedInput = z.infer<typeof voidedSchema>;

/** Documento de venta ya normalizado (factura, boleta o nota). */
export type SaleDocument = (InvoiceInput | NoteInput) & {
  company: CompanyInput;
  correlativo: string;
  fechaEmision: string;
};

/* ------------------------------------------------------------------ *
 * Guía de Remisión Electrónica (GRE 2022, API REST de SUNAT)
 * ------------------------------------------------------------------ */

export const directionSchema = z.object({
  ubigueo: codigo,
  direccion: z.string(),
  codLocal: codigo.optional(),
  ruc: codigo.optional(),
});

export const transportistSchema = z.object({
  tipoDoc: codigo,
  numDoc: codigo,
  rznSocial: z.string(),
  nroMtc: codigo.optional(),
  placa: codigo.optional(),
  choferTipoDoc: codigo.optional(),
  choferDoc: codigo.optional(),
});

export const vehicleSchema: z.ZodType<{
  placa: string;
  nroCirculacion?: string;
  codEmisor?: string;
  nroAutorizacion?: string;
  secundarios?: unknown[];
}> = z.lazy(() => z.object({
  placa: codigo,
  nroCirculacion: codigo.optional(),
  codEmisor: codigo.optional(),
  nroAutorizacion: codigo.optional(),
  secundarios: z.array(vehicleSchema).optional(),
}));

export const driverSchema = z.object({
  /** 'Principal' o 'Secundario'. */
  tipo: z.string().default('Principal'),
  tipoDoc: codigo,
  nroDoc: codigo,
  nombres: z.string(),
  apellidos: z.string(),
  licencia: codigo,
});

export const puertoSchema = z.object({ codigo: codigo, nombre: z.string() });

export const shipmentSchema = z.object({
  /** Catálogo 20: motivo del traslado. */
  codTraslado: codigo,
  desTraslado: z.string().optional(),
  sustentoPeso: z.string().optional(),
  indTransbordo: z.boolean().optional(),
  indicadores: z.array(z.string()).optional(),
  pesoItems: importe.optional(),
  pesoTotal: importe,
  undPesoTotal: codigo.default('KGM'),
  numBultos: z.coerce.number().optional(),
  /** Catálogo 18: 01 = transporte público, 02 = privado. */
  modTraslado: codigo,
  fecTraslado: z.string(),
  fecEntregaBienes: z.string().optional(),
  contenedores: z.array(z.string()).optional(),
  puerto: puertoSchema.optional(),
  aeropuerto: puertoSchema.optional(),
  transportista: transportistSchema.optional(),
  vehiculo: vehicleSchema.optional(),
  choferes: z.array(driverSchema).optional(),
  llegada: directionSchema,
  partida: directionSchema,
});

export const additionalDocSchema = z.object({
  tipo: codigo,
  tipoDesc: z.string().optional(),
  nro: codigo,
  emisor: codigo.optional(),
});

export const despatchDetailSchema = z.object({
  codigo: codigo.optional(),
  descripcion: z.string(),
  unidad: codigo.default('NIU'),
  cantidad: importe,
  codProdSunat: codigo.optional(),
  atributos: z.array(detailAttributeSchema).optional(),
});

export const despatchSchema = z.object({
  /** 09 = Guía de Remisión Remitente, 31 = Transportista. */
  tipoDoc: z.enum(['09', '31']).default('09'),
  serie: codigo,
  correlativo: codigo.optional(),
  fechaEmision: z.string().optional(),
  observacion: z.string().optional(),
  company: companySchema.optional(),
  destinatario: clientSchema,
  comprador: clientSchema.optional(),
  tercero: clientSchema.optional(),
  docBaja: documentSchema.optional(),
  relDoc: documentSchema.optional(),
  addDocs: z.array(additionalDocSchema).optional(),
  envio: shipmentSchema,
  details: z.array(despatchDetailSchema).min(1),
});

export type DespatchInput = z.infer<typeof despatchSchema>;

/* ------------------------------------------------------------------ *
 * Comprobantes de Retención (20) y Percepción (40)
 * ------------------------------------------------------------------ */

export const exchangeSchema = z.object({
  monedaRef: codigo.default('USD'),
  monedaObj: codigo.default('PEN'),
  factor: importe,
  fecha: z.string(),
});

export const paymentSchema = z.object({
  moneda: codigo.default('PEN'),
  importe: importe,
  fecha: z.string(),
});

export const retentionDetailSchema = z.object({
  /** Catálogo 01: tipo del comprobante sobre el que se retiene. */
  tipoDoc: codigo,
  numDoc: codigo,
  fechaEmision: z.string(),
  moneda: codigo.default('PEN'),
  impTotal: importe,
  pagos: z.array(paymentSchema).optional(),
  fechaRetencion: z.string(),
  impRetenido: importe,
  /** Importe neto pagado al proveedor tras la retención. */
  impPagar: importe,
  tipoCambio: exchangeSchema.optional(),
});

export const retentionSchema = z.object({
  serie: codigo,
  correlativo: codigo.optional(),
  fechaEmision: z.string().optional(),
  company: companySchema.optional(),
  proveedor: clientSchema,
  /** Catálogo 23: régimen de retención (01 = tasa 3 %). */
  regimen: codigo.default('01'),
  tasa: importe.default(3),
  impRetenido: importe,
  impPagado: importe,
  observacion: z.string().optional(),
  details: z.array(retentionDetailSchema).min(1),
});

export const perceptionDetailSchema = z.object({
  tipoDoc: codigo,
  numDoc: codigo,
  fechaEmision: z.string(),
  moneda: codigo.default('PEN'),
  impTotal: importe,
  cobros: z.array(paymentSchema).optional(),
  fechaPercepcion: z.string(),
  impPercibido: importe,
  /** Importe total cobrado al cliente, percepción incluida. */
  impCobrar: importe,
  tipoCambio: exchangeSchema.optional(),
});

export const perceptionSchema = z.object({
  serie: codigo,
  correlativo: codigo.optional(),
  fechaEmision: z.string().optional(),
  company: companySchema.optional(),
  proveedor: clientSchema,
  /** Catálogo 22: régimen de percepción (01 = venta interna, tasa 2 %). */
  regimen: codigo.default('01'),
  tasa: importe.default(2),
  impPercibido: importe,
  impCobrado: importe,
  observacion: z.string().optional(),
  details: z.array(perceptionDetailSchema).min(1),
});

export type RetentionInput = z.infer<typeof retentionSchema>;
export type PerceptionInput = z.infer<typeof perceptionSchema>;
