import { createHash } from "node:crypto";
import { strToU8, zipSync, zlibSync } from "fflate";

const xml = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
const packageTypes = (overrides: string) => `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
const relationships = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
const officeRelationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
function archive(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { mtime: new Date(2000, 0, 1), level: 6 });
}
function word(reference: string): Uint8Array {
  return archive({
    "[Content_Types].xml": packageTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    "_rels/.rels": relationships(`<Relationship Id="rId1" Type="${officeRelationship}officeDocument" Target="word/document.xml"/>`),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic dispatch document</w:t></w:r></w:p><w:p><w:r><w:t>Document reference: ${xml(reference)}</w:t></w:r></w:p><w:p><w:r><w:t>Unicode witness: 東京 · café · Δοκιμή</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  });
}
function workbook(reference: string): Uint8Array {
  return archive({
    "[Content_Types].xml": packageTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
    "_rels/.rels": relationships(`<Relationship Id="rId1" Type="${officeRelationship}officeDocument" Target="xl/workbook.xml"/>`),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officeRelationship.slice(0, -1)}"><sheets><sheet name="Reference" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships(`<Relationship Id="rId1" Type="${officeRelationship}worksheet" Target="worksheets/sheet1.xml"/>`),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Workbook reference</t></is></c><c r="B1" t="inlineStr"><is><t>${xml(reference)}</t></is></c></row></sheetData></worksheet>`,
  });
}
function pdf(reference: string): Uint8Array {
  const content = `BT /F1 20 Tf 72 720 Td (Synthetic dispatch fixture) Tj 0 -40 Td /F1 14 Tf (PDF reference: ${reference}) Tj ET\n`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let text = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const startxref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return strToU8(text);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const chunk = Buffer.alloc(data.byteLength + 12); chunk.writeUInt32BE(data.byteLength, 0); chunk.write(name, 4, "ascii"); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.byteLength - 4); return chunk;
}
function label(code: string): Uint8Array {
  const width = 360, height = 220, stride = width * 4 + 1, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([247, 249, 252, 255], y * stride + 1 + x * 4);
  const segments: Record<string, [number, number, number, number]> = { a: [12, 0, 40, 10], b: [52, 10, 10, 45], c: [52, 65, 10, 45], d: [12, 110, 40, 10], e: [2, 65, 10, 45], f: [2, 10, 10, 45], g: [12, 55, 40, 10] };
  const digits = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
  [...code].forEach((digit, index) => {
    for (const [name, [x, y, w, h]] of Object.entries(segments)) {
      const color = digits[Number(digit)]!.includes(name) ? [20, 42, 68, 255] : [230, 234, 239, 255];
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) pixels.set(color, (y + dy + 50) * stride + 1 + (x + dx + 90 + index * 100) * 4);
    }
  });
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", zlibSync(pixels)), pngChunk("IEND", new Uint8Array())]);
}

/** Fixed package metadata and seed-derived contents make fixtures reproducible across efforts. */
export function createFormatFixtures(seed: string, withImage: boolean): { files: Record<string, Uint8Array>; answers: Record<string, string> } {
  const identity = createHash("sha256").update(seed).digest("hex").toUpperCase();
  const answers: Record<string, string> = { pdfReference: `P-${identity.slice(0, 8)}`, documentReference: `D-${identity.slice(8, 16)}`, workbookReference: `X-${identity.slice(16, 24)}` };
  const files: Record<string, Uint8Array> = { "input/dispatch.pdf": pdf(answers.pdfReference!), "input/dispatch.docx": word(answers.documentReference!), "input/dispatch.xlsx": workbook(answers.workbookReference!) };
  if (withImage) { answers.imageCode = String(Number.parseInt(identity.slice(24, 30), 16) % 100).padStart(2, "0"); files["input/label.png"] = label(answers.imageCode); }
  return { files, answers };
}
