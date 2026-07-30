import JSZip from 'jszip';

/** Empaqueta el XML firmado en el .zip que exige SUNAT (un único archivo). */
export async function zipXml(fileName: string, xml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(`${fileName}.xml`, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Devuelve el primer XML encontrado dentro de un .zip (usado para la CDR). */
export async function unzipFirstXml(zipBuffer: Buffer): Promise<{ name: string; xml: string } | null> {
  const zip = await JSZip.loadAsync(zipBuffer);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!entry.name.toLowerCase().endsWith('.xml')) continue;
    return { name: entry.name, xml: await entry.async('string') };
  }
  return null;
}
