import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, posix } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false
});

type XmlNode = Record<string, unknown>;

export type CellPrimitive = string | number | boolean | null;

export type ParsedCell = {
  reference: string;
  row: number;
  column: number;
  value: CellPrimitive;
  formula: string | null;
  styleIndex: number | null;
  sourceType: string | null;
};

export type MergeRange = {
  reference: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

export type ParsedImageReference = {
  sheetName: string;
  sourceRow: number;
  sourceColumn: number;
  anchorIndex: number;
  mediaPath: string;
  checksumSha256: string;
  byteSize: number;
  extension: string;
};

export type ParsedWorksheet = {
  name: string;
  path: string;
  maxRow: number;
  maxColumn: number;
  hiddenRows: Set<number>;
  merges: MergeRange[];
  images: ParsedImageReference[];
  cells: Map<string, ParsedCell>;
  getCell(row: number, column: number, inheritMerged?: boolean): ParsedCell | undefined;
};

export type ParsedWorkbook = {
  worksheets: ParsedWorksheet[];
  mediaFileCount: number;
  getWorksheet(name: string): ParsedWorksheet | undefined;
};

type Relationship = { id: string; type: string; target: string };

const builtInDateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

export async function parseOpenXmlWorkbook(filePath: string): Promise<ParsedWorkbook> {
  const source = await readFile(filePath);
  const zip = unzipSync(new Uint8Array(source));
  const sharedStrings = parseSharedStrings(readXml(zip, "xl/sharedStrings.xml", false));
  const dateStyles = parseDateStyles(readXml(zip, "xl/styles.xml", false));
  const workbook = readXml(zip, "xl/workbook.xml");
  const workbookRelationships = parseRelationships(zip, "xl/_rels/workbook.xml.rels");
  const relationshipById = new Map(workbookRelationships.map((item) => [item.id, item]));
  const sheetNodes = asArray(asObject(asObject(workbook.workbook).sheets).sheet);
  const worksheets: ParsedWorksheet[] = [];

  for (const sheetNodeValue of sheetNodes) {
    const sheetNode = asObject(sheetNodeValue);
    const name = stringAttribute(sheetNode, "name");
    const relationshipId = stringAttribute(sheetNode, "id");
    const relationship = relationshipById.get(relationshipId);
    if (!name || !relationship) throw new Error(`工作表关系缺失: ${name || relationshipId}`);
    const sheetPath = resolvePartPath("xl/workbook.xml", relationship.target);
    worksheets.push(parseWorksheet(zip, sheetPath, name, sharedStrings, dateStyles));
  }

  return {
    worksheets,
    mediaFileCount: Object.keys(zip).filter((entry) => entry.startsWith("xl/media/") && !entry.endsWith("/")).length,
    getWorksheet(name: string) {
      return worksheets.find((sheet) => sheet.name === name);
    }
  };
}

function parseWorksheet(
  zip: Record<string, Uint8Array>,
  sheetPath: string,
  name: string,
  sharedStrings: string[],
  dateStyles: Set<number>
): ParsedWorksheet {
  const document = readXml(zip, sheetPath);
  const worksheet = asObject(document.worksheet);
  const rowNodes = asArray(asObject(worksheet.sheetData).row);
  const cells = new Map<string, ParsedCell>();
  const hiddenRows = new Set<number>();
  const dimensionReference = stringAttribute(asObject(worksheet.dimension), "ref");
  const dimension = dimensionReference ? parseRangeReference(dimensionReference) : null;
  let maxRow = dimension?.endRow ?? 0;
  let maxColumn = dimension?.endColumn ?? 0;

  for (const rowNodeValue of rowNodes) {
    const rowNode = asObject(rowNodeValue);
    const rowNumber = numberAttribute(rowNode, "r") ?? 0;
    if (rowNumber <= 0) continue;
    if (stringAttribute(rowNode, "hidden") === "1" || stringAttribute(rowNode, "hidden") === "true") {
      hiddenRows.add(rowNumber);
    }
    for (const cellNodeValue of asArray(rowNode.c)) {
      const cell = parseCell(asObject(cellNodeValue), sharedStrings, dateStyles);
      if (!cell) continue;
      cells.set(cell.reference, cell);
      if (!dimension) {
        maxRow = Math.max(maxRow, cell.row);
        maxColumn = Math.max(maxColumn, cell.column);
      }
    }
  }

  const merges = asArray(asObject(worksheet.mergeCells).mergeCell)
    .map((item) => stringAttribute(asObject(item), "ref"))
    .filter(Boolean)
    .map(parseRangeReference);
  const mergeOwner = new Map<string, string>();
  for (const merge of merges) {
    const owner = cellReference(merge.startRow, merge.startColumn);
    for (let row = merge.startRow; row <= merge.endRow; row += 1) {
      for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
        mergeOwner.set(cellReference(row, column), owner);
      }
    }
  }

  const images = parseImages(zip, sheetPath, name, worksheet);
  const parsed: ParsedWorksheet = {
    name,
    path: sheetPath,
    maxRow,
    maxColumn,
    hiddenRows,
    merges,
    images,
    cells,
    getCell(row: number, column: number, inheritMerged = false) {
      const reference = cellReference(row, column);
      const direct = cells.get(reference);
      if (!inheritMerged || (direct && (direct.value !== null || direct.formula))) return direct;
      const owner = mergeOwner.get(reference);
      return owner ? cells.get(owner) : direct;
    }
  };
  return parsed;
}

function parseCell(node: XmlNode, sharedStrings: string[], dateStyles: Set<number>): ParsedCell | undefined {
  const reference = stringAttribute(node, "r");
  if (!reference) return undefined;
  const position = parseCellReference(reference);
  const sourceType = stringAttribute(node, "t") || null;
  const styleIndex = numberAttribute(node, "s");
  const formula = nodeText(node.f) || null;
  const rawValue = node.v === undefined ? null : nodeText(node.v);
  let value: CellPrimitive = rawValue;

  if (sourceType === "s") {
    value = sharedStrings[Number(rawValue)] ?? "";
  } else if (sourceType === "inlineStr") {
    value = nodeText(node.is);
  } else if (sourceType === "b") {
    value = rawValue === "1";
  } else if (sourceType === "str" || sourceType === "e") {
    value = rawValue;
  } else if (rawValue !== null && rawValue !== "" && Number.isFinite(Number(rawValue))) {
    const numeric = Number(rawValue);
    value = styleIndex !== null && dateStyles.has(styleIndex) ? excelSerialToIso(numeric) : numeric;
  }

  return { reference, ...position, value, formula, styleIndex, sourceType };
}

function parseImages(
  zip: Record<string, Uint8Array>,
  sheetPath: string,
  sheetName: string,
  worksheet: XmlNode
): ParsedImageReference[] {
  const drawingNode = asObject(worksheet.drawing);
  const drawingRelationshipId = stringAttribute(drawingNode, "id");
  if (!drawingRelationshipId) return [];
  const sheetRelationships = parseRelationships(zip, relationshipPartPath(sheetPath));
  const drawingRelationship = sheetRelationships.find((item) => item.id === drawingRelationshipId);
  if (!drawingRelationship) throw new Error(`绘图关系缺失: ${sheetName}/${drawingRelationshipId}`);
  const drawingPath = resolvePartPath(sheetPath, drawingRelationship.target);
  const drawingDocument = readXml(zip, drawingPath);
  const drawingRoot = asObject(drawingDocument.wsDr);
  const anchors = [
    ...asArray(drawingRoot.twoCellAnchor),
    ...asArray(drawingRoot.oneCellAnchor),
    ...asArray(drawingRoot.absoluteAnchor)
  ];
  const drawingRelationships = parseRelationships(zip, relationshipPartPath(drawingPath));
  const relationshipById = new Map(drawingRelationships.map((item) => [item.id, item]));

  return anchors.map((anchorValue, anchorIndex) => {
    const anchor = asObject(anchorValue);
    const from = asObject(anchor.from);
    const sourceRow = Number(nodeText(from.row)) + 1;
    const sourceColumn = Number(nodeText(from.col)) + 1;
    const picture = asObject(anchor.pic);
    const blipFill = asObject(picture.blipFill);
    const blip = asObject(blipFill.blip);
    const relationshipId = stringAttribute(blip, "embed");
    const relationship = relationshipById.get(relationshipId);
    if (!relationship) throw new Error(`图片关系缺失: ${sheetName}/${relationshipId}`);
    const mediaPath = resolvePartPath(drawingPath, relationship.target);
    const bytes = zip[mediaPath];
    if (!bytes) throw new Error(`图片文件缺失: ${mediaPath}`);
    return {
      sheetName,
      sourceRow,
      sourceColumn,
      anchorIndex,
      mediaPath,
      checksumSha256: sha256(bytes),
      byteSize: bytes.byteLength,
      extension: extname(mediaPath).replace(/^\./, "").toLowerCase()
    };
  });
}

function parseSharedStrings(document: XmlNode | null): string[] {
  if (!document) return [];
  return asArray(asObject(document.sst).si).map((item) => nodeText(item));
}

function parseDateStyles(document: XmlNode | null): Set<number> {
  if (!document) return new Set();
  const styleSheet = asObject(document.styleSheet);
  const customFormats = new Map<number, string>();
  for (const value of asArray(asObject(styleSheet.numFmts).numFmt)) {
    const item = asObject(value);
    const id = numberAttribute(item, "numFmtId");
    if (id !== null) customFormats.set(id, stringAttribute(item, "formatCode"));
  }
  const dateStyles = new Set<number>();
  asArray(asObject(styleSheet.cellXfs).xf).forEach((value, index) => {
    const numFmtId = numberAttribute(asObject(value), "numFmtId") ?? 0;
    const custom = customFormats.get(numFmtId) ?? "";
    if (builtInDateFormats.has(numFmtId) || isDateFormat(custom)) dateStyles.add(index);
  });
  return dateStyles;
}

function parseRelationships(zip: Record<string, Uint8Array>, path: string): Relationship[] {
  const document = readXml(zip, path, false);
  if (!document) return [];
  return asArray(asObject(document.Relationships).Relationship).map((value) => {
    const item = asObject(value);
    return {
      id: stringAttribute(item, "Id"),
      type: stringAttribute(item, "Type"),
      target: stringAttribute(item, "Target")
    };
  });
}

function readXml(zip: Record<string, Uint8Array>, path: string, required?: true): XmlNode;
function readXml(zip: Record<string, Uint8Array>, path: string, required: false): XmlNode | null;
function readXml(zip: Record<string, Uint8Array>, path: string, required = true): XmlNode | null {
  const bytes = zip[path];
  if (!bytes) {
    if (required) throw new Error(`OpenXML部件缺失: ${path}`);
    return null;
  }
  return asObject(xmlParser.parse(new TextDecoder().decode(bytes)));
}

function relationshipPartPath(partPath: string) {
  return posix.join(posix.dirname(partPath), "_rels", `${posix.basename(partPath)}.rels`);
}

function resolvePartPath(basePart: string, target: string) {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  return posix.normalize(posix.join(posix.dirname(basePart), target));
}

function parseRangeReference(reference: string): MergeRange {
  const [start, end = start] = reference.split(":");
  const startCell = parseCellReference(start);
  const endCell = parseCellReference(end);
  return {
    reference,
    startRow: startCell.row,
    startColumn: startCell.column,
    endRow: endCell.row,
    endColumn: endCell.column
  };
}

export function parseCellReference(reference: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(reference);
  if (!match) throw new Error(`非法单元格引用: ${reference}`);
  return { column: columnNumber(match[1].toUpperCase()), row: Number(match[2]) };
}

export function columnNumber(letters: string) {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

export function columnLetters(column: number) {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function cellReference(row: number, column: number) {
  return `${columnLetters(column)}${row}`;
}

function excelSerialToIso(serial: number) {
  const milliseconds = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
  return new Date(milliseconds).toISOString().replace(/T00:00:00\.000Z$/, "");
}

function isDateFormat(format: string) {
  const withoutQuoted = format.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /(^|[^a-z])[ymdhis]+([^a-z]|$)/i.test(withoutQuoted);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function asObject(value: unknown): XmlNode {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XmlNode : {};
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringAttribute(node: XmlNode, name: string) {
  const direct = node[`@_${name}`];
  if (direct !== undefined && direct !== null) return String(direct);
  const match = Object.entries(node).find(([key]) => key.startsWith("@_") && key.split(":").pop()?.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : "";
}

function numberAttribute(node: XmlNode, name: string): number | null {
  const value = stringAttribute(node, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nodeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(nodeText).join("");
  const node = asObject(value);
  if (node["#text"] !== undefined) return nodeText(node["#text"]);
  if (node.t !== undefined) return nodeText(node.t);
  if (node.r !== undefined) return nodeText(node.r);
  return Object.entries(node).filter(([key]) => !key.startsWith("@_")).map(([, item]) => nodeText(item)).join("");
}
