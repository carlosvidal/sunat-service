import { afectacionDe } from './catalogs.ts';
import type { InvoiceInput, NoteInput, SaleDetailInput } from './schemas.ts';
import { round, sum } from '../util/money.ts';
import { numeroALetras } from '../util/numero-letras.ts';

type SaleLike = InvoiceInput | NoteInput;

/**
 * Completa los importes que el cliente no envió, tanto a nivel de línea como
 * de documento. Los valores enviados explícitamente NUNCA se sobrescriben:
 * el emisor es la fuente de verdad y SUNAT valida la coherencia.
 */
export function completarTotales<T extends SaleLike>(doc: T): T {
  const details = doc.details.map((d) => completarLinea(d));
  const out = { ...doc, details } as T;

  const acc = {
    gravadas: 0,
    exoneradas: 0,
    inafectas: 0,
    exportacion: 0,
    gratuitas: 0,
    ivapBase: 0,
    igv: 0,
    igvGratuitas: 0,
    ivap: 0,
    isc: 0,
    baseIsc: 0,
    oth: 0,
    baseOth: 0,
    icbper: 0,
  };

  for (const d of details) {
    const cat = afectacionDe(d.tipAfeIgv);
    const valor = d.mtoValorVenta ?? 0;
    switch (cat) {
      case 'gravado':
        acc.gravadas += valor;
        acc.igv += d.igv ?? 0;
        break;
      case 'ivap':
        acc.ivapBase += valor;
        acc.ivap += d.igv ?? 0;
        break;
      case 'exonerado':
        acc.exoneradas += valor;
        break;
      case 'inafecto':
        acc.inafectas += valor;
        break;
      case 'exportacion':
        acc.exportacion += valor;
        break;
      case 'gratuito':
        acc.gratuitas += valor;
        acc.igvGratuitas += d.igv ?? 0;
        break;
    }
    acc.isc += d.isc ?? 0;
    acc.baseIsc += d.mtoBaseIsc ?? 0;
    acc.oth += d.otroTributo ?? 0;
    acc.baseOth += d.mtoBaseOth ?? 0;
    acc.icbper += d.icbper ?? 0;
  }

  const has = (v: number | undefined) => v !== undefined && v !== null;

  if (!has(out.mtoOperGravadas) && acc.gravadas > 0) out.mtoOperGravadas = round(acc.gravadas);
  if (!has(out.mtoOperExoneradas) && acc.exoneradas > 0) out.mtoOperExoneradas = round(acc.exoneradas);
  if (!has(out.mtoOperInafectas) && acc.inafectas > 0) out.mtoOperInafectas = round(acc.inafectas);
  if (!has(out.mtoOperExportacion) && acc.exportacion > 0) out.mtoOperExportacion = round(acc.exportacion);
  if (!has(out.mtoOperGratuitas) && acc.gratuitas > 0) out.mtoOperGratuitas = round(acc.gratuitas);
  if (!has(out.mtoBaseIvap) && acc.ivapBase > 0) out.mtoBaseIvap = round(acc.ivapBase);
  if (!has(out.mtoIvap) && acc.ivap > 0) out.mtoIvap = round(acc.ivap);
  if (!has(out.mtoIGV)) out.mtoIGV = round(acc.igv);
  if (!has(out.mtoIGVGratuitas) && acc.igvGratuitas > 0) out.mtoIGVGratuitas = round(acc.igvGratuitas);
  if (!has(out.mtoISC) && acc.isc > 0) out.mtoISC = round(acc.isc);
  if (!has(out.mtoBaseIsc) && acc.baseIsc > 0) out.mtoBaseIsc = round(acc.baseIsc);
  if (!has(out.mtoOtrosTributos) && acc.oth > 0) out.mtoOtrosTributos = round(acc.oth);
  if (!has(out.mtoBaseOth) && acc.baseOth > 0) out.mtoBaseOth = round(acc.baseOth);
  if (!has(out.icbper) && acc.icbper > 0) out.icbper = round(acc.icbper);

  if (!has(out.totalImpuestos)) {
    out.totalImpuestos = sum([out.mtoIGV, out.mtoIvap, out.mtoISC, out.mtoOtrosTributos, out.icbper]);
  }
  if (!has(out.valorVenta)) {
    out.valorVenta = sum([out.mtoOperGravadas, out.mtoOperExoneradas, out.mtoOperInafectas, out.mtoOperExportacion, out.mtoBaseIvap]);
  }
  if (!has(out.subTotal)) {
    out.subTotal = sum([out.valorVenta, out.totalImpuestos, out.sumOtrosCargos, -(out.sumOtrosDescuentos ?? 0)]);
  }
  if (!has(out.mtoImpVenta)) {
    out.mtoImpVenta = sum([out.subTotal, -(out.totalAnticipos ?? 0)]);
  }

  // Leyenda 1000 (monto en letras): obligatoria en toda factura/boleta/nota.
  const legends = out.legends ? [...out.legends] : [];
  if (!legends.some((l) => l.code === '1000')) {
    legends.push({ code: '1000', value: numeroALetras(out.mtoImpVenta ?? 0, out.tipoMoneda) });
  }
  // Leyenda 1002 para operaciones gratuitas.
  if ((out.mtoOperGratuitas ?? 0) > 0 && !legends.some((l) => l.code === '1002')) {
    legends.push({ code: '1002', value: 'TRANSFERENCIA GRATUITA DE UN BIEN Y/O SERVICIO PRESTADO GRATUITAMENTE' });
  }
  out.legends = legends;

  return out;
}

function completarLinea(d: SaleDetailInput): SaleDetailInput {
  const out = { ...d };
  const cat = afectacionDe(out.tipAfeIgv);
  const gratuito = cat === 'gratuito';
  const cantidad = out.cantidad;

  const valorUnitarioBase = gratuito
    ? (out.mtoValorGratuito ?? out.mtoValorUnitario ?? 0)
    : (out.mtoValorUnitario ?? 0);

  if (out.mtoValorUnitario === undefined) out.mtoValorUnitario = gratuito ? 0 : valorUnitarioBase;
  if (gratuito && out.mtoValorGratuito === undefined) out.mtoValorGratuito = valorUnitarioBase;

  if (out.mtoValorVenta === undefined) {
    out.mtoValorVenta = round(cantidad * valorUnitarioBase - (out.descuento ?? 0));
  }

  // ISC: se calcula antes del IGV porque forma parte de su base imponible.
  if (out.porcentajeIsc !== undefined && out.isc === undefined) {
    if (out.mtoBaseIsc === undefined) out.mtoBaseIsc = out.mtoValorVenta;
    out.isc = round(out.mtoBaseIsc * (out.porcentajeIsc / 100));
  }
  if (out.isc !== undefined && out.mtoBaseIsc === undefined) out.mtoBaseIsc = out.mtoValorVenta;

  if (out.mtoBaseIgv === undefined) out.mtoBaseIgv = round((out.mtoValorVenta ?? 0) + (out.isc ?? 0));
  if (cat === 'exonerado' || cat === 'inafecto' || cat === 'exportacion') out.porcentajeIgv = 0;
  if (out.igv === undefined) out.igv = round(out.mtoBaseIgv * (out.porcentajeIgv / 100));

  // ICBPER: impuesto fijo por bolsa (catálogo de factor vigente al año).
  if (out.factorIcbper !== undefined && out.icbper === undefined) {
    out.icbper = round(cantidad * out.factorIcbper);
  }

  if (out.otroTributo !== undefined && out.mtoBaseOth === undefined) out.mtoBaseOth = out.mtoValorVenta;

  if (out.totalImpuestos === undefined) {
    out.totalImpuestos = sum([out.igv, out.isc, out.otroTributo, out.icbper]);
  }

  if (out.mtoPrecioUnitario === undefined) {
    if (gratuito) out.mtoPrecioUnitario = 0;
    else {
      const iscUnit = cantidad !== 0 ? (out.isc ?? 0) / cantidad : 0;
      const base = (out.mtoValorUnitario ?? 0) + iscUnit;
      out.mtoPrecioUnitario = round(base * (1 + out.porcentajeIgv / 100), 10);
    }
  }

  return out;
}

/** Errores de coherencia detectados antes de gastar una llamada a SUNAT. */
export function validarTotales(doc: SaleLike): string[] {
  const errores: string[] = [];
  const lineas = sum(doc.details.map((d) => d.mtoValorVenta ?? 0));
  const declarado = sum([
    doc.mtoOperGravadas, doc.mtoOperExoneradas, doc.mtoOperInafectas,
    doc.mtoOperExportacion, doc.mtoOperGratuitas, doc.mtoBaseIvap,
  ]);

  /*
   * Los descuentos y cargos globales y los anticipos modifican legítimamente la
   * base declarada respecto a la suma de las líneas: un descuento global que
   * afecta la base (catálogo 53) la reduce, y un anticipo se descuenta de la
   * operación gravada. Por eso la diferencia sólo se considera un error cuando
   * excede lo que esos ajustes pueden explicar; el detalle fino lo valida SUNAT.
   */
  const ajustes = sum([
    ...(doc.descuentos ?? []).map((d) => Math.abs(d.monto)),
    ...(doc.cargos ?? []).map((c) => Math.abs(c.monto)),
    doc.totalAnticipos,
  ]);

  if (Math.abs(lineas - declarado) > ajustes + 0.05) {
    errores.push(
      `La suma de mtoValorVenta de los ítems (${lineas.toFixed(2)}) no coincide con los totales por tipo de operación (${declarado.toFixed(2)})` +
      (ajustes > 0 ? `, ni siquiera considerando los descuentos, cargos y anticipos declarados (${ajustes.toFixed(2)})` : ''),
    );
  }
  if ((doc.mtoImpVenta ?? 0) < 0) errores.push('mtoImpVenta no puede ser negativo');
  return errores;
}
