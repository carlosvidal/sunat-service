/** Catálogos SUNAT usados por el generador de XML. */

export interface Tributo {
  id: string;
  name: string;
  code: string;
}

export const TRIBUTO_IGV: Tributo = { id: '1000', name: 'IGV', code: 'VAT' };
export const TRIBUTO_IVAP: Tributo = { id: '1016', name: 'IVAP', code: 'VAT' };
export const TRIBUTO_ISC: Tributo = { id: '2000', name: 'ISC', code: 'EXC' };
export const TRIBUTO_ICBPER: Tributo = { id: '7152', name: 'ICBPER', code: 'OTH' };
export const TRIBUTO_EXPORTACION: Tributo = { id: '9995', name: 'EXP', code: 'FRE' };
export const TRIBUTO_GRATUITO: Tributo = { id: '9996', name: 'GRA', code: 'FRE' };
export const TRIBUTO_EXONERADO: Tributo = { id: '9997', name: 'EXO', code: 'VAT' };
export const TRIBUTO_INAFECTO: Tributo = { id: '9998', name: 'INA', code: 'FRE' };
export const TRIBUTO_OTROS: Tributo = { id: '9999', name: 'OTROS', code: 'OTH' };

/** Categoría económica derivada del tipo de afectación del IGV (catálogo 07). */
export type Afectacion = 'gravado' | 'ivap' | 'exonerado' | 'inafecto' | 'exportacion' | 'gratuito';

const AFECTACION: Record<string, Afectacion> = {
  '10': 'gravado',
  '17': 'ivap',
  '11': 'gratuito',
  '12': 'gratuito',
  '13': 'gratuito',
  '14': 'gratuito',
  '15': 'gratuito',
  '16': 'gratuito',
  '20': 'exonerado',
  '21': 'gratuito',
  '30': 'inafecto',
  '31': 'gratuito',
  '32': 'gratuito',
  '33': 'gratuito',
  '34': 'gratuito',
  '35': 'gratuito',
  '36': 'gratuito',
  '37': 'gratuito',
  '40': 'exportacion',
};

const TRIBUTO_POR_AFECTACION: Record<Afectacion, Tributo> = {
  gravado: TRIBUTO_IGV,
  ivap: TRIBUTO_IVAP,
  exonerado: TRIBUTO_EXONERADO,
  inafecto: TRIBUTO_INAFECTO,
  exportacion: TRIBUTO_EXPORTACION,
  gratuito: TRIBUTO_GRATUITO,
};

export function afectacionDe(tipAfeIgv: string): Afectacion {
  const a = AFECTACION[tipAfeIgv];
  if (!a) throw new Error(`tipAfeIgv "${tipAfeIgv}" no pertenece al catálogo 07`);
  return a;
}

export function tributoDe(tipAfeIgv: string): Tributo {
  return TRIBUTO_POR_AFECTACION[afectacionDe(tipAfeIgv)];
}

/** Tipos de comprobante (catálogo 01) soportados. */
export const TIPO_DOC = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
} as const;

export const NOMBRE_TIPO_DOC: Record<string, string> = {
  '01': 'FACTURA ELECTRÓNICA',
  '03': 'BOLETA DE VENTA ELECTRÓNICA',
  '07': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '08': 'NOTA DE DÉBITO ELECTRÓNICA',
  RC: 'RESUMEN DIARIO DE BOLETAS',
  RA: 'COMUNICACIÓN DE BAJA',
};

/** Catálogo 06: tipo de documento de identidad. */
export const NOMBRE_TIPO_DOC_IDENTIDAD: Record<string, string> = {
  '0': 'DOC.TRIB.NO.DOM.SIN.RUC',
  '1': 'DNI',
  '4': 'CARNET DE EXTRANJERIA',
  '6': 'RUC',
  '7': 'PASAPORTE',
  A: 'CED. DIPLOMATICA DE IDENTIDAD',
};
