import { expect, test } from "bun:test";
import { unzipSync, strFromU8, unzlibSync } from "fflate";
import { createFormatFixtures } from "../scripts/golden/formats";

test("format fixtures carry distinct references in valid document packages and a real PNG raster", () => {
  const fixture = createFormatFixtures("fixed-format-seed", true);
  expect(fixture).toEqual(createFormatFixtures("fixed-format-seed", true));
  expect(fixture.answers).not.toEqual(createFormatFixtures("different-seed", true).answers);
  const docx = unzipSync(fixture.files["input/dispatch.docx"]!);
  expect(strFromU8(docx["word/document.xml"]!)).toContain(fixture.answers.documentReference!);
  const workbook = unzipSync(fixture.files["input/dispatch.xlsx"]!);
  expect(strFromU8(workbook["xl/worksheets/sheet1.xml"]!)).toContain(fixture.answers.workbookReference!);
  const pdf = Buffer.from(fixture.files["input/dispatch.pdf"]!).toString("utf8");
  expect(pdf.startsWith("%PDF-1.4")).toBe(true);
  expect(pdf).toContain(fixture.answers.pdfReference!);
  const png = Buffer.from(fixture.files["input/label.png"]!);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([360, 220]);
  const data: Uint8Array[] = [];
  for (let position = 8; position < png.byteLength;) {
    const length = png.readUInt32BE(position);
    if (png.toString("ascii", position + 4, position + 8) === "IDAT") data.push(png.subarray(position + 8, position + 8 + length));
    position += length + 12;
  }
  expect(unzlibSync(Buffer.concat(data))).toHaveLength((360 * 4 + 1) * 220);
  expect(fixture.answers.imageCode).toMatch(/^\d{2}$/);
});
