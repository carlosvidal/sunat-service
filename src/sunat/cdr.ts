import { DOMParser } from '@xmldom/xmldom';
import { unzipFirstXml } from './zip.ts';
import { clasificar, type SunatSeverity } from './errors.ts';

export interface CdrResponse {
  accepted: boolean;
  severity: SunatSeverity;
  id: string;
  code: string;
  description: string;
  notes: string[];
}

type XmlDoc = ReturnType<DOMParser['parseFromString']>;

function textOf(doc: XmlDoc, localName: string): string[] {
  const nodes = doc.getElementsByTagName('*');
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i);
    if (!node) continue;
    if (node.localName === localName) out.push((node.textContent ?? '').trim());
  }
  return out;
}

/** Parsea el ApplicationResponse (CDR) que SUNAT devuelve dentro del .zip. */
export function parseCdrXml(xml: string): CdrResponse {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const code = textOf(doc, 'ResponseCode')[0] ?? '';
  const description = textOf(doc, 'Description')[0] ?? '';
  const id = textOf(doc, 'ReferenceID')[0] ?? textOf(doc, 'ID')[0] ?? '';
  const notes = textOf(doc, 'Note').filter(Boolean);
  const severity = clasificar(code);
  return {
    accepted: severity === 'aceptado' || severity === 'observacion',
    severity,
    id,
    code,
    description,
    notes,
  };
}

/** Abre el .zip de la CDR y parsea su contenido. */
export async function parseCdrZip(zip: Buffer): Promise<CdrResponse> {
  const entry = await unzipFirstXml(zip);
  if (!entry) throw new Error('La CDR recibida no contiene un XML');
  return parseCdrXml(entry.xml);
}
