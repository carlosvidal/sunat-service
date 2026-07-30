/**
 * Ejemplos que se muestran en la documentación interactiva (/docs).
 * Son payloads reales: pueden pegarse tal cual en "Try it out".
 */

const cliente = {
  tipoDoc: '6',
  numDoc: '20000000002',
  rznSocial: 'EMPRESA CLIENTE S.A.C.',
  address: {
    direccion: 'AV. JAVIER PRADO ESTE 123',
    ubigueo: '150101',
    departamento: 'LIMA',
    provincia: 'LIMA',
    distrito: 'LIMA',
  },
};

/** Factura gravada simple: el servicio calcula IGV, totales y leyenda. */
export const EJEMPLO_FACTURA = {
  tipoDoc: '01',
  serie: 'F001',
  fechaEmision: '2026-07-29T10:00:00-05:00',
  tipoMoneda: 'PEN',
  formaPago: { moneda: 'PEN', tipo: 'Contado' },
  client: cliente,
  details: [
    {
      codProducto: 'SERV-001',
      unidad: 'ZZ',
      descripcion: 'SUSCRIPCION SOFTWARE PLAN PRO (MES)',
      cantidad: 1,
      mtoValorUnitario: 1000,
    },
  ],
};

/** Boleta con ICBPER (bolsa plástica) y cliente con DNI. */
export const EJEMPLO_BOLETA = {
  tipoDoc: '03',
  serie: 'B001',
  tipoMoneda: 'PEN',
  client: { tipoDoc: '1', numDoc: '46543212', rznSocial: 'JUAN PEREZ' },
  details: [
    { codProducto: 'P1', unidad: 'NIU', descripcion: 'POLO ALGODON', cantidad: 3, mtoValorUnitario: 25.42 },
    { codProducto: 'BOLSA', unidad: 'NIU', descripcion: 'BOLSA PLASTICA', cantidad: 2, mtoValorUnitario: 0.05, factorIcbper: 0.5 },
  ],
};

/** Factura con detracción: `tipoOperacion` 1001 y el bloque `detraccion`. */
export const EJEMPLO_FACTURA_DETRACCION = {
  tipoDoc: '01',
  serie: 'F001',
  tipoOperacion: '1001',
  tipoMoneda: 'PEN',
  client: cliente,
  detraccion: {
    codBienDetraccion: '014',
    codMedioPago: '001',
    ctaBanco: '00047-3342343243',
    percent: 4,
    mount: 37.76,
  },
  details: [
    { codProducto: 'SERV-01', unidad: 'ZZ', descripcion: 'SERVICIO DE TRANSPORTE', cantidad: 4, mtoValorUnitario: 200 },
  ],
};

/** Factura al crédito con cuotas. */
export const EJEMPLO_FACTURA_CREDITO = {
  tipoDoc: '01',
  serie: 'F001',
  tipoMoneda: 'PEN',
  fecVencimiento: '2026-08-29',
  formaPago: { moneda: 'PEN', tipo: 'Credito', monto: 1180 },
  cuotas: [
    { moneda: 'PEN', monto: 590, fechaPago: '2026-08-15' },
    { moneda: 'PEN', monto: 590, fechaPago: '2026-08-29' },
  ],
  client: cliente,
  details: [
    { codProducto: 'P1', unidad: 'NIU', descripcion: 'PRODUCTO 1', cantidad: 1, mtoValorUnitario: 1000 },
  ],
};

/** Factura de exportación: `tipAfeIgv` 40, sin IGV. */
export const EJEMPLO_FACTURA_EXPORTACION = {
  tipoDoc: '01',
  serie: 'F001',
  tipoOperacion: '0200',
  tipoMoneda: 'USD',
  client: {
    tipoDoc: '0',
    numDoc: '00000000',
    rznSocial: 'FOREIGN COMPANY LLC',
    address: { direccion: '123 MAIN ST, MIAMI', codigoPais: 'US' },
  },
  details: [
    { codProducto: 'P1', unidad: 'NIU', descripcion: 'ARTESANIA EXPORTACION', cantidad: 10, mtoValorUnitario: 50, tipAfeIgv: '40' },
  ],
};

/** Nota de crédito que anula una factura (catálogo 09, motivo 01). */
export const EJEMPLO_NOTA_CREDITO = {
  tipoDoc: '07',
  serie: 'FC01',
  tipDocAfectado: '01',
  numDocfectado: 'F001-1',
  codMotivo: '01',
  desMotivo: 'ANULACION DE LA OPERACION',
  tipoMoneda: 'PEN',
  client: cliente,
  details: [
    { codProducto: 'SERV-001', unidad: 'ZZ', descripcion: 'SUSCRIPCION SOFTWARE PLAN PRO (MES)', cantidad: 1, mtoValorUnitario: 1000 },
  ],
};

/** Nota de débito por intereses (catálogo 10, motivo 01). */
export const EJEMPLO_NOTA_DEBITO = {
  tipoDoc: '08',
  serie: 'FD01',
  tipDocAfectado: '01',
  numDocfectado: 'F001-1',
  codMotivo: '01',
  desMotivo: 'INTERESES POR MORA',
  tipoMoneda: 'PEN',
  client: cliente,
  details: [
    { codProducto: 'INT', unidad: 'ZZ', descripcion: 'INTERES POR MORA', cantidad: 1, mtoValorUnitario: 50 },
  ],
};

/**
 * Resumen diario de boletas. `fecGeneracion` es el día de las boletas y
 * `fecResumen` el día en que se envía (debe coincidir con el nombre del archivo).
 */
export const EJEMPLO_RESUMEN = {
  correlativo: '1',
  fecGeneracion: '2026-07-29',
  fecResumen: '2026-07-30',
  moneda: 'PEN',
  details: [
    {
      tipoDoc: '03',
      serieNro: 'B001-1',
      estado: '1',
      clienteTipo: '1',
      clienteNro: '46543212',
      total: 90,
      mtoOperGravadas: 76.27,
      mtoIGV: 13.73,
    },
  ],
};

/** Comunicación de baja de una factura. */
export const EJEMPLO_BAJA = {
  correlativo: '1',
  fecGeneracion: '2026-07-29',
  fecComunicacion: '2026-07-30',
  details: [
    { tipoDoc: '01', serie: 'F001', correlativo: '1', desMotivoBaja: 'ERROR EN LOS CALCULOS' },
  ],
};

/** Guía de remisión remitente por venta, transporte público. */
export const EJEMPLO_GUIA = {
  tipoDoc: '09',
  serie: 'T001',
  destinatario: { tipoDoc: '6', numDoc: '20000000002', rznSocial: 'EMPRESA CLIENTE S.A.C.' },
  envio: {
    codTraslado: '01',
    desTraslado: 'VENTA',
    modTraslado: '01',
    fecTraslado: '2026-07-31',
    pesoTotal: 12.5,
    undPesoTotal: 'KGM',
    llegada: { ubigueo: '150101', direccion: 'AV. LIMA 100' },
    partida: { ubigueo: '150203', direccion: 'AV. ITALIA 200' },
    transportista: { tipoDoc: '6', numDoc: '20000000003', rznSocial: 'TRANSPORTES S.A.C.', placa: 'ABI-453' },
  },
  details: [
    { codigo: 'PROD1', unidad: 'ZZ', descripcion: 'PRODUCTO 1', cantidad: 2 },
  ],
};

/** Alta de empresa emisora. */
export const EJEMPLO_EMPRESA = {
  tenant_id: 'tienda-123',
  ruc: '20000000001',
  razon_social: 'MI EMPRESA S.A.C.',
  nombre_comercial: 'MI EMPRESA',
  domicilio_fiscal: {
    ubigueo: '150101',
    direccion: 'AV. LIMA 100',
    departamento: 'LIMA',
    provincia: 'LIMA',
    distrito: 'LIMA',
  },
  sol_user: 'MODDATOS',
  sol_pass: 'MODDATOS',
  certificado: '<certificado .pfx en base64>',
  cert_password: 'clave-del-certificado',
  environment: 'beta',
  webhook_url: 'https://mi-backend.pe/webhooks/sunat',
  webhook_secret: 'un-secreto-compartido',
};

/** Comprobante de retención: el agente retiene el 3 % al pagar a su proveedor. */
export const EJEMPLO_RETENCION = {
  serie: 'R001',
  fechaEmision: '2026-07-29T10:00:00-05:00',
  proveedor: {
    tipoDoc: '6',
    numDoc: '20000000002',
    rznSocial: 'PROVEEDOR S.A.C.',
    address: { direccion: 'AV. PROVEEDOR 456' },
  },
  regimen: '01',
  tasa: 3,
  impRetenido: 10,
  impPagado: 200,
  observacion: 'RETENCION IGV',
  details: [
    {
      tipoDoc: '01',
      numDoc: 'F001-1',
      fechaEmision: '2026-07-20',
      moneda: 'PEN',
      impTotal: 210,
      fechaRetencion: '2026-07-29',
      impRetenido: 10,
      impPagar: 200,
      pagos: [{ moneda: 'PEN', importe: 200, fecha: '2026-07-29' }],
    },
  ],
};

/** Comprobante de percepción: el agente cobra el 2 % adicional a su cliente. */
export const EJEMPLO_PERCEPCION = {
  serie: 'P001',
  fechaEmision: '2026-07-29T10:00:00-05:00',
  proveedor: {
    tipoDoc: '6',
    numDoc: '20000000002',
    rznSocial: 'CLIENTE S.A.C.',
    address: { direccion: 'AV. CLIENTE 123' },
  },
  regimen: '01',
  tasa: 2,
  impPercibido: 4,
  impCobrado: 204,
  observacion: 'PERCEPCION VENTA INTERNA',
  details: [
    {
      tipoDoc: '01',
      numDoc: 'F001-2',
      fechaEmision: '2026-07-20',
      moneda: 'PEN',
      impTotal: 200,
      fechaPercepcion: '2026-07-29',
      impPercibido: 4,
      impCobrar: 204,
      cobros: [{ moneda: 'PEN', importe: 204, fecha: '2026-07-29' }],
    },
  ],
};
