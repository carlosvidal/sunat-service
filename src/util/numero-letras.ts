/** Conversión de importes a letras para la leyenda 1000 exigida por SUNAT. */

const UNIDADES = [
  '', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE',
  'DIECIOCHO', 'DIECINUEVE', 'VEINTE',
];
const DECENAS = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = [
  '', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS',
];

const MONEDAS: Record<string, string> = {
  PEN: 'SOLES',
  USD: 'DOLARES AMERICANOS',
  EUR: 'EUROS',
  CLP: 'PESOS CHILENOS',
  COP: 'PESOS COLOMBIANOS',
  ARS: 'PESOS ARGENTINOS',
  BRL: 'REALES',
  MXN: 'PESOS MEXICANOS',
  GBP: 'LIBRAS ESTERLINAS',
  JPY: 'YENES',
};

function menorMil(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS[c]!);
  if (resto > 0) {
    if (resto <= 20) partes.push(UNIDADES[resto]!);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u === 0 ? DECENAS[d]! : `${DECENAS[d]} Y ${UNIDADES[u]}`);
    }
  }
  return partes.join(' ');
}

/** Convierte la parte entera de un número a letras (soporta hasta miles de millones). */
export function enteroALetras(entero: number): string {
  if (entero === 0) return 'CERO';

  const bloques: Array<{ valor: number; singular: string; plural: string }> = [
    { valor: 1_000_000_000, singular: 'MIL MILLONES', plural: 'MIL MILLONES' },
    { valor: 1_000_000, singular: 'UN MILLON', plural: 'MILLONES' },
    { valor: 1_000, singular: 'MIL', plural: 'MIL' },
  ];

  let resto = entero;
  const partes: string[] = [];

  for (const b of bloques) {
    const cant = Math.floor(resto / b.valor);
    if (cant === 0) continue;
    resto %= b.valor;
    if (b.valor === 1_000) {
      partes.push(cant === 1 ? 'MIL' : `${menorMil(cant)} MIL`);
    } else if (b.valor === 1_000_000) {
      partes.push(cant === 1 ? 'UN MILLON' : `${menorMil(cant)} MILLONES`);
    } else {
      partes.push(cant === 1 ? 'MIL MILLONES' : `${menorMil(cant)} MIL MILLONES`);
    }
  }

  if (resto > 0) partes.push(menorMil(resto));
  return partes.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Genera el texto de la leyenda 1000.
 * Ej: numeroALetras(336, 'PEN') => 'SON TRESCIENTOS TREINTA Y SEIS CON 00/100 SOLES'
 */
export function numeroALetras(monto: number, moneda = 'PEN'): string {
  const abs = Math.abs(monto);
  const entero = Math.floor(abs);
  const centavos = Math.round((abs - entero) * 100);
  // El redondeo de centavos puede desbordar a 100 (ej. 9.999)
  const enteroFinal = centavos === 100 ? entero + 1 : entero;
  const centavosFinal = centavos === 100 ? 0 : centavos;
  const nombreMoneda = MONEDAS[moneda.toUpperCase()] ?? moneda.toUpperCase();
  const letras = enteroALetras(enteroFinal);
  return `SON ${letras} CON ${String(centavosFinal).padStart(2, '0')}/100 ${nombreMoneda}`;
}
