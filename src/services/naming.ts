import { compactDate } from '../util/dates.ts';

/** Nombre del archivo de un CPE: 20123456789-01-F001-123 */
export function nombreCpe(ruc: string, tipoDoc: string, serie: string, correlativo: string | number): string {
  return `${ruc}-${tipoDoc}-${serie}-${correlativo}`;
}

/** Nombre e ID de un Resumen Diario: 20123456789-RC-20260729-001 */
export function nombreResumen(ruc: string, fecha: string, correlativo: string): { name: string; xmlId: string } {
  const dia = compactDate(fecha);
  return { name: `${ruc}-RC-${dia}-${correlativo}`, xmlId: `RC-${dia}-${correlativo}` };
}

/** Nombre e ID de una Comunicación de Baja: 20123456789-RA-20260729-001 */
export function nombreBaja(ruc: string, fecha: string, correlativo: string): { name: string; xmlId: string } {
  const dia = compactDate(fecha);
  return { name: `${ruc}-RA-${dia}-${correlativo}`, xmlId: `RA-${dia}-${correlativo}` };
}
