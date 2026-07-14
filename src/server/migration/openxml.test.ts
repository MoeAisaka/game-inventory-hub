import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOpenXmlWorkbook } from "./openxml";

let directory = "";
let workbookPath = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openxml-migration-"));
  workbookPath = join(directory, "fixture.xlsx");
  const xml = (value: string) => strToU8(value);
  const archive = zipSync({
    "xl/workbook.xml": xml(`<workbook xmlns:r="r"><sheets><sheet name="测试" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(`<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="styles" Target="styles.xml"/></Relationships>`),
    "xl/sharedStrings.xml": xml(`<sst><si><t>父值</t></si><si><r><t>富</t></r><r><t>文本</t></r></si></sst>`),
    "xl/styles.xml": xml(`<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": xml(`<worksheet xmlns:r="r"><dimension ref="A1:M3"/><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" s="1" t="n"><v>45292</v></c></row><row r="3"><c r="A3"/></row></sheetData><mergeCells><mergeCell ref="A2:A3"/></mergeCells><drawing r:id="rId1"/></worksheet>`),
    "xl/worksheets/_rels/sheet1.xml.rels": xml(`<Relationships><Relationship Id="rId1" Type="drawing" Target="/xl/drawings/drawing1.xml"/></Relationships>`),
    "xl/drawings/drawing1.xml": xml(`<wsDr xmlns:r="r"><oneCellAnchor><from><col>12</col><row>1</row></from><pic><blipFill><blip r:embed="rId1"/></blipFill></pic></oneCellAnchor></wsDr>`),
    "xl/drawings/_rels/drawing1.xml.rels": xml(`<Relationships><Relationship Id="rId1" Type="image" Target="../media/image1.png"/></Relationships>`),
    "xl/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  });
  await writeFile(workbookPath, archive);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("OpenXML parser", () => {
  it("reads shared strings, rich text, date styles, merged inheritance and image anchors", async () => {
    const workbook = await parseOpenXmlWorkbook(workbookPath);
    const sheet = workbook.getWorksheet("测试");
    expect(sheet?.getCell(1, 1)?.value).toBe("富文本");
    expect(sheet?.getCell(3, 1, true)?.value).toBe("父值");
    expect(sheet?.getCell(2, 2)?.value).toBe("2024-01-01");
    expect(sheet?.images).toHaveLength(1);
    expect(sheet?.images[0]).toMatchObject({ sourceRow: 2, sourceColumn: 13, extension: "png", byteSize: 7 });
    expect(workbook.mediaFileCount).toBe(1);
  });
});
