export type Ambiente = 'beta' | 'produccion';

/** Servicios SOAP de SUNAT según ambiente y familia de comprobante. */
export const ENDPOINTS = {
  beta: {
    /** Facturas, boletas, notas, resúmenes y bajas. */
    cpe: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
    /** Retenciones, percepciones y guías (formato antiguo). */
    otros: 'https://e-beta.sunat.gob.pe/ol-ti-itemision-otroscpe-gem-beta/billService',
    /** Consulta de CDR. */
    consulta: 'https://e-beta.sunat.gob.pe/ol-it-wsconscpegem-beta/billConsultService',
    /** API REST de la nueva Guía de Remisión Electrónica (GRE). */
    gre: 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem',
    greToken: 'https://api-seguridad.sunat.gob.pe/v1/clientessol',
  },
  produccion: {
    cpe: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
    otros: 'https://e-factura.sunat.gob.pe/ol-ti-itemision-otroscpe-gem/billService',
    consulta: 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService',
    gre: 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem',
    greToken: 'https://api-seguridad.sunat.gob.pe/v1/clientessol',
  },
} as const;

export function endpointFor(ambiente: Ambiente, servicio: 'cpe' | 'otros' | 'consulta'): string {
  return ENDPOINTS[ambiente][servicio];
}
