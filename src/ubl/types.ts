import type { InvoiceInput, NoteInput, SummaryInput, VoidedInput, CompanyInput } from '../domain/schemas.ts';

export interface ChargeLike {
  codTipo: string;
  factor?: number;
  monto: number;
  montoBase?: number;
}

/**
 * Documento de venta listo para serializar: emisor resuelto, correlativo
 * asignado y totales completos. Une factura/boleta y notas para reutilizar
 * el generador de XML.
 */
export type SaleDoc = Omit<InvoiceInput, 'company' | 'tipoDoc'> & Partial<Omit<NoteInput, 'company' | 'tipoDoc'>> & {
  tipoDoc: string;
  company: CompanyInput;
  correlativo: string;
  fechaEmision: string;
};

export type SummaryDoc = Omit<SummaryInput, 'company'> & {
  company: CompanyInput;
  /** Identificador del XML: RC-YYYYMMDD-###. */
  xmlId: string;
};

export type VoidedDoc = Omit<VoidedInput, 'company'> & {
  company: CompanyInput;
  /** Identificador del XML: RA-YYYYMMDD-###. */
  xmlId: string;
};
