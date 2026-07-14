import { createHash } from "node:crypto";
import type { ImportIssue } from "@/server/db/schema";
import {
  columnLetters,
  type CellPrimitive,
  type ParsedImageReference,
  type ParsedWorkbook,
  type ParsedWorksheet
} from "./openxml";

export type StagedRecordType = "GAME" | "ASSET" | "INVENTORY";
export type StagedRowStatus = "SUCCESS" | "WARNING" | "ERROR" | "EXCLUDED";

export type StagedRow = {
  sheetName: string;
  sourceRow: number;
  recordType: StagedRecordType;
  rowChecksum: string;
  status: StagedRowStatus;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown> | null;
  issues: ImportIssue[];
};

export type StagedImage = ParsedImageReference & {
  status: StagedRowStatus;
  issues: ImportIssue[];
};

export type Reconciliation = {
  metric: string;
  expectedCount: number;
  actualCount: number;
  passed: boolean;
  details: Record<string, unknown>;
};

export type MigrationAnalysis = {
  rows: StagedRow[];
  images: StagedImage[];
  reconciliations: Reconciliation[];
  summary: {
    sourceSheets: Array<{ name: string; maxRow: number; maxColumn: number; hiddenRows: number; merges: number }>;
    rowCounts: Record<StagedRowStatus, number>;
    acceptedByType: Record<StagedRecordType, number>;
    issueCounts: Record<string, number>;
    imageReferenceCount: number;
    mediaFileCount: number;
    uniqueImageChecksums: number;
    duplicateGameNameGroups: number;
    allHardGatesPassed: boolean;
    readyForCommit: boolean;
  };
};

const platformMap: Record<string, string> = {
  STEAM: "STEAM",
  PS: "PLAYSTATION",
  XGP: "XBOX_GAME_PASS",
  PC: "PC_OTHER",
  "PC+": "PC_OTHER",
  NS: "NINTENDO_SWITCH",
  NS2: "NINTENDO_SWITCH_2",
  "3DS": "NINTENDO_3DS",
  PSV: "PLAYSTATION_VITA",
  IOS: "IOS"
};

const mediaMap: Record<string, string> = {
  数字: "DIGITAL",
  实体: "PHYSICAL",
  订阅: "SUBSCRIPTION",
  订阅制: "SUBSCRIPTION",
  破解: "UNOFFICIAL_COPY"
};

const ownershipMap: Record<string, string> = {
  OK: "OWNED",
  "-": "TO_ACQUIRE",
  NO: "NOT_ACQUIRING",
  "/": "UNKNOWN"
};

export function analyzeMigrationWorkbook(workbook: ParsedWorkbook): MigrationAnalysis {
  const games = requireSheet(workbook, "游戏清单");
  const assets = requireSheet(workbook, "科技产品（非消耗品）");
  const inventory = requireSheet(workbook, "库存");
  const gameRows = normalizeGames(games);
  const duplicateGameNameGroups = markDuplicateGameNames(gameRows);
  const assetRows = normalizeAssets(assets);
  const inventoryRows = normalizeInventory(inventory);
  const rows = [...gameRows, ...assetRows, ...inventoryRows];
  const acceptedAssetRows = new Set(assetRows.filter(isAccepted).map((row) => row.sourceRow));
  const images = assets.images.map((image) => normalizeImage(image, acceptedAssetRows));
  const acceptedByType = countAcceptedByType(rows);
  const stagedByType = countStagedByType(rows);
  const outOfScopeInventoryAccepted = inventoryRows.filter((row) => row.sourceRow >= 53 && isAccepted(row)).length;
  const formulaValuesImported = rows.filter((row) => stableStringify(row.normalizedPayload).includes('"formula"')).length;
  const reconciliations: Reconciliation[] = [
    reconcile("game_records", 380, stagedByType.GAME, { sheet: games.name, sourceRows: "2-381", errorRows: gameRows.filter((row) => row.status === "ERROR").length }),
    reconcile("asset_records", 334, stagedByType.ASSET, { sheet: assets.name, sourceRows: "2-336" }),
    reconcile("asset_image_anchors", 282, images.length, { mediaFileCount: workbook.mediaFileCount }),
    reconcile("inventory_records", 50, stagedByType.INVENTORY, { sheet: inventory.name, allowedRows: "2-52" }),
    reconcile("inventory_rows_after_52_imported", 0, outOfScopeInventoryAccepted, { hardExclusionStartsAt: 53 }),
    reconcile("formula_payloads_imported", 0, formulaValuesImported, { formulasRetainedOnlyInRawDebugMetadata: true })
  ];
  const rowCounts = countStatuses(rows);
  const issueCounts = countIssues(rows, images);
  return {
    rows,
    images,
    reconciliations,
    summary: {
      sourceSheets: workbook.worksheets.map((sheet) => ({
        name: sheet.name,
        maxRow: sheet.maxRow,
        maxColumn: sheet.maxColumn,
        hiddenRows: sheet.hiddenRows.size,
        merges: sheet.merges.length
      })),
      rowCounts,
      acceptedByType,
      issueCounts,
      imageReferenceCount: images.length,
      mediaFileCount: workbook.mediaFileCount,
      uniqueImageChecksums: new Set(images.map((image) => image.checksumSha256)).size,
      duplicateGameNameGroups,
      allHardGatesPassed: reconciliations.every((item) => item.passed),
      readyForCommit: reconciliations.every((item) => item.passed) && rowCounts.ERROR === 0
    }
  };
}

function normalizeGames(sheet: ParsedWorksheet) {
  const rows: StagedRow[] = [];
  for (let sourceRow = 2; sourceRow <= 381; sourceRow += 1) {
    const issues: ImportIssue[] = [];
    const rawPayload = snapshotRow(sheet, sourceRow, 1, 21);
    const nameZh = textValue(sheet, sourceRow, 1);
    if (!nameZh) error(issues, "GAME_NAME_REQUIRED", "游戏中文主名称不能为空", "A");
    const platformSource = textValue(sheet, sourceRow, 4).toUpperCase();
    const mediaSource = textValue(sheet, sourceRow, 5);
    const ownershipSource = normalizeDash(textValue(sheet, sourceRow, 6)).toUpperCase();
    const platform = platformMap[platformSource] ?? null;
    const mediaType = mediaMap[mediaSource] ?? null;
    const ownershipStatus = ownershipMap[ownershipSource] ?? null;
    if (platformSource && !platform) warning(issues, "GAME_PLATFORM_UNKNOWN", `未识别游戏平台：${platformSource}`, "D");
    if (mediaSource && !mediaType) warning(issues, "GAME_MEDIA_UNKNOWN", `未识别游戏介质：${mediaSource}`, "E");
    if (ownershipSource && !ownershipStatus) warning(issues, "GAME_OWNERSHIP_UNKNOWN", `未识别拥有状态：${ownershipSource}`, "F");
    const priority = parsePriority(textValue(sheet, sourceRow, 11), issues);
    const startValue = value(sheet, sourceRow, 14);
    const endValue = value(sheet, sourceRow, 15);
    const playthrough = inferPlaythrough(startValue, endValue, issues);
    const normalizedPayload = {
      nameZh,
      nameEn: nullableText(sheet, sourceRow, 2),
      notes: nullableText(sheet, sourceRow, 3),
      platformSource: platformSource || null,
      platform,
      mediaSource: mediaSource || null,
      mediaType,
      ownershipSource: ownershipSource || null,
      ownershipStatus,
      handheldBest: booleanFromSource(textValue(sheet, sourceRow, 7)),
      proEnhanced: triStateBoolean(textValue(sheet, sourceRow, 8)),
      controllerFeatures: nullableText(sheet, sourceRow, 9),
      modRequired: booleanFromSource(textValue(sheet, sourceRow, 10)) ?? false,
      ...priority,
      releaseDate: dateValue(sheet, sourceRow, 13, issues, "M"),
      ...playthrough,
      acquisitionNotes: nullableText(sheet, sourceRow, 18)
    };
    rows.push(stagedRow(sheet.name, sourceRow, "GAME", rawPayload, normalizedPayload, issues));
  }
  return rows;
}

function normalizeAssets(sheet: ParsedWorksheet) {
  const rows: StagedRow[] = [];
  for (let sourceRow = 2; sourceRow <= sheet.maxRow; sourceRow += 1) {
    const hasBusinessIdentity = [1, 2, 3, 4, 5, 6].some((column) => !isBlank(value(sheet, sourceRow, column)));
    if (!hasBusinessIdentity) {
      rows.push(excludedRow(sheet, sourceRow, "ASSET", sourceRow >= 337 ? "FORMULA_ONLY_TAIL" : "EMPTY_ROW"));
      continue;
    }
    const issues: ImportIssue[] = [];
    const rawPayload = snapshotRow(sheet, sourceRow, 1, 12);
    const categoryLarge = nullableText(sheet, sourceRow, 1, true);
    const categorySmall = nullableText(sheet, sourceRow, 2, true);
    const parentType = slashToNull(nullableText(sheet, sourceRow, 3, true));
    const parentName = slashToNull(nullableText(sheet, sourceRow, 4, true));
    const childType = slashToNull(nullableText(sheet, sourceRow, 5, true));
    const childName = slashToNull(nullableText(sheet, sourceRow, 6, true));
    const hasChild = Boolean(childType || childName);
    const assetName = hasChild ? childName || childType : parentName || parentType;
    if (!assetName) error(issues, "ASSET_NAME_REQUIRED", "资产名称无法从C-F列推导", "C:F");
    if (!categoryLarge) warning(issues, "ASSET_CATEGORY_MISSING", "资产大类缺失", "A");
    if (hasChild && !(parentName || parentType)) error(issues, "ASSET_PARENT_MISSING", "子资产缺少父资产上下文", "C:D");
    const purchasePrice = parseMoney(value(sheet, sourceRow, 9), issues, "I");
    const saleRaw = parseMoney(value(sheet, sourceRow, 10), issues, "J");
    const saleIncome = saleRaw === null ? null : Math.abs(saleRaw);
    const normalizedPayload = {
      categoryLarge,
      categorySmall,
      assetLevel: hasChild ? "CHILD" : "PARENT",
      assetName,
      parentType,
      parentName,
      childType,
      childName,
      purchasedAt: dateValue(sheet, sourceRow, 7, issues, "G"),
      purchaseChannel: nullableText(sheet, sourceRow, 8),
      purchasePrice,
      saleIncome,
      netCost: purchasePrice === null ? null : roundMoney(purchasePrice - (saleIncome ?? 0)),
      status: saleIncome && saleIncome > 0 ? "SOLD" : "ACTIVE",
      notes: nullableText(sheet, sourceRow, 12)
    };
    rows.push(stagedRow(sheet.name, sourceRow, "ASSET", rawPayload, normalizedPayload, issues));
  }
  return rows;
}

function normalizeInventory(sheet: ParsedWorksheet) {
  const rows: StagedRow[] = [];
  for (let sourceRow = 2; sourceRow <= sheet.maxRow; sourceRow += 1) {
    if (sourceRow >= 53) {
      rows.push(excludedRow(sheet, sourceRow, "INVENTORY", "OUT_OF_SCOPE_AFTER_ROW_52"));
      continue;
    }
    const businessColumns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17];
    const hasBusinessValue = businessColumns.some((column) => !isBlank(value(sheet, sourceRow, column)));
    if (!hasBusinessValue) {
      rows.push(excludedRow(sheet, sourceRow, "INVENTORY", "EMPTY_ROW_IN_ALLOWED_RANGE"));
      continue;
    }
    const issues: ImportIssue[] = [];
    const rawPayload = snapshotRow(sheet, sourceRow, 1, 17);
    const productName = nullableText(sheet, sourceRow, 1, true);
    const colorSource = nullableText(sheet, sourceRow, 6, true);
    if (!productName) error(issues, "INVENTORY_PRODUCT_REQUIRED", "库存商品名称不能为空", "A");
    if (!colorSource) error(issues, "INVENTORY_COLOR_REQUIRED", "库存颜色不能为空", "F");
    const purchased = parseCount(value(sheet, sourceRow, 10), issues, "J");
    const opened = parseCount(value(sheet, sourceRow, 12), issues, "L");
    const discarded = parseCount(value(sheet, sourceRow, 13), issues, "M");
    const unopenedQuantity = purchased - opened - discarded;
    if (unopenedQuantity < 0) error(issues, "INVENTORY_NEGATIVE_BALANCE", "购入数量小于拆封与废弃数量之和", "J:M");
    const oldLocation = nullableText(sheet, sourceRow, 16, true);
    const newLocation = nullableText(sheet, sourceRow, 17, true);
    const currentLocation = plausibleLocation(newLocation) ? newLocation : oldLocation;
    if (newLocation && !plausibleLocation(newLocation)) warning(issues, "INVENTORY_LOCATION_SUSPECT", "新位置疑似评价文本，已回退旧位置", "Q");
    const repurchaseSource = nullableText(sheet, sourceRow, 15, true);
    const normalizedPayload = {
      productName,
      priorityCode: nullableText(sheet, sourceRow, 2, true),
      brand: nullableText(sheet, sourceRow, 3, true),
      style: nullableText(sheet, sourceRow, 4, true),
      denier: nullableText(sheet, sourceRow, 5, true),
      colorSource,
      color: normalizeColor(colorSource),
      material: nullableText(sheet, sourceRow, 7, true),
      composition: nullableText(sheet, sourceRow, 8, true),
      unitPrice: parseMoney(value(sheet, sourceRow, 9), issues, "I"),
      purchased,
      opened,
      discarded,
      unopenedQuantity,
      openedQuantity: opened,
      totalHeldQuantity: unopenedQuantity + opened,
      notes: nullableText(sheet, sourceRow, 14),
      repurchaseSource,
      repurchaseDecision: inferRepurchase(repurchaseSource),
      oldLocation,
      newLocation,
      currentLocation
    };
    rows.push(stagedRow(sheet.name, sourceRow, "INVENTORY", rawPayload, normalizedPayload, issues));
  }
  return rows;
}

function normalizeImage(image: ParsedImageReference, acceptedRows: Set<number>): StagedImage {
  const issues: ImportIssue[] = [];
  if (!acceptedRows.has(image.sourceRow)) {
    error(issues, "IMAGE_ASSET_ROW_MISSING", "图片锚点未关联到可导入资产行");
  }
  if (!new Set(["png", "jpg", "jpeg", "webp"]).has(image.extension)) {
    warning(issues, "IMAGE_EXTENSION_UNEXPECTED", `图片扩展名未纳入白名单：${image.extension}`);
  }
  return { ...image, status: statusFromIssues(issues), issues };
}

function markDuplicateGameNames(rows: StagedRow[]) {
  const groups = new Map<string, StagedRow[]>();
  for (const row of rows) {
    const name = normalizeText(row.normalizedPayload?.nameZh).toLocaleLowerCase("zh-CN");
    if (!name) continue;
    const list = groups.get(name) ?? [];
    list.push(row);
    groups.set(name, list);
  }
  let duplicateGroups = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    for (const row of group) {
      warning(row.issues, "DUPLICATE_GAME_NAME", `同名游戏共${group.length}行，仅提示、不自动合并`, "A");
      row.status = statusFromIssues(row.issues);
      row.rowChecksum = checksum({ rawPayload: row.rawPayload, normalizedPayload: row.normalizedPayload, issues: row.issues });
    }
  }
  return duplicateGroups;
}

function stagedRow(
  sheetName: string,
  sourceRow: number,
  recordType: StagedRecordType,
  rawPayload: Record<string, unknown>,
  normalizedPayload: Record<string, unknown>,
  issues: ImportIssue[]
): StagedRow {
  const status = statusFromIssues(issues);
  return {
    sheetName,
    sourceRow,
    recordType,
    status,
    rawPayload,
    normalizedPayload,
    issues,
    rowChecksum: checksum({ rawPayload, normalizedPayload, issues })
  };
}

function excludedRow(sheet: ParsedWorksheet, sourceRow: number, recordType: StagedRecordType, code: string): StagedRow {
  const populatedColumns = [...sheet.cells.values()]
    .filter((cell) => cell.row === sourceRow && (!isBlank(cell.value) || Boolean(cell.formula)))
    .map((cell) => columnLetters(cell.column));
  const rawPayload = { excluded: true, populatedColumns, valuesRedacted: sourceRow >= 53 && recordType === "INVENTORY" };
  const issues: ImportIssue[] = [{ code, message: exclusionMessage(code), severity: "WARNING" }];
  return {
    sheetName: sheet.name,
    sourceRow,
    recordType,
    status: "EXCLUDED",
    rawPayload,
    normalizedPayload: null,
    issues,
    rowChecksum: checksum({ rawPayload, issues })
  };
}

function snapshotRow(sheet: ParsedWorksheet, row: number, startColumn: number, endColumn: number) {
  const cells: Record<string, CellPrimitive> = {};
  const formulas: Record<string, string> = {};
  for (let column = startColumn; column <= endColumn; column += 1) {
    const cell = sheet.getCell(row, column);
    if (!cell) continue;
    const letter = columnLetters(column);
    if (!isBlank(cell.value)) cells[letter] = cell.value;
    if (cell.formula) formulas[letter] = cell.formula;
  }
  return { cells, formulas, hidden: sheet.hiddenRows.has(row) };
}

function parsePriority(source: string, issues: ImportIssue[]) {
  const normalized = source.trim().toUpperCase();
  if (!normalized) return { priorityLevel: null, priorityRank: null, repeatable: false, prioritySource: null };
  if (normalized === "~") return { priorityLevel: null, priorityRank: null, repeatable: true, prioritySource: source };
  const match = /^([0-5])([AB])?$/.exec(normalized);
  if (!match) {
    warning(issues, "GAME_PRIORITY_REVIEW", `优先级需人工复核：${source}`, "K");
    return { priorityLevel: null, priorityRank: null, repeatable: false, prioritySource: source };
  }
  return { priorityLevel: Number(match[1]), priorityRank: match[2] ?? null, repeatable: false, prioritySource: source };
}

function inferPlaythrough(start: CellPrimitive, end: CellPrimitive, issues: ImportIssue[]) {
  const startDate = asIsoDate(start);
  const endDate = asIsoDate(end);
  const startSymbol = normalizeDash(normalizeText(start));
  const endSymbol = normalizeDash(normalizeText(end));
  let status: string | null = null;
  if (endDate) status = "COMPLETED";
  else if (endSymbol === "-") status = "ABANDONED";
  else if (startDate && (endSymbol === "/" || !endSymbol)) status = "PLAYING";
  else if (startSymbol === "/" && (endSymbol === "/" || !endSymbol)) status = "BACKLOG";
  else if (startSymbol === "-") status = "UNPLANNED";
  else if (!startSymbol && !endSymbol) status = null;
  else warning(issues, "GAME_PLAY_STATUS_REVIEW", `开始/结束组合需复核：${startSymbol || "空"}/${endSymbol || "空"}`, "N:O");
  if (startDate && endDate && endDate < startDate) error(issues, "GAME_DATE_ORDER_INVALID", "完成日期早于开始日期", "N:O");
  return { playStatus: status, startedAt: startDate, completedAt: endDate };
}

function dateValue(sheet: ParsedWorksheet, row: number, column: number, issues: ImportIssue[], field: string) {
  const source = value(sheet, row, column);
  if (isBlank(source) || source === "/") return null;
  const date = asIsoDate(source);
  if (!date) warning(issues, "DATE_REVIEW", `日期无法标准化：${normalizeText(source)}`, field);
  return date;
}

function asIsoDate(value: CellPrimitive) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseMoney(source: CellPrimitive, issues: ImportIssue[], field: string): number | null {
  if (isBlank(source) || source === "/") return null;
  const normalized = typeof source === "number" ? source : Number(normalizeText(source).replace(/[，,]/g, ".").replace(/[￥¥元\s]/g, ""));
  if (!Number.isFinite(normalized)) {
    error(issues, "MONEY_INVALID", `金额无法解析：${normalizeText(source)}`, field);
    return null;
  }
  return roundMoney(normalized);
}

function parseCount(source: CellPrimitive, issues: ImportIssue[], field: string) {
  if (isBlank(source) || source === "/") return 0;
  const parsed = typeof source === "number" ? source : Number(normalizeText(source));
  if (!Number.isInteger(parsed) || parsed < 0) {
    error(issues, "QUANTITY_INVALID", `数量必须为非负整数：${normalizeText(source)}`, field);
    return 0;
  }
  return parsed;
}

function inferRepurchase(source: string | null) {
  if (!source) return "UNDECIDED";
  const normalized = source.toUpperCase();
  if (/否|NO/.test(normalized)) return "DO_NOT_REPURCHASE";
  if (/后续|观察|再补/.test(source)) return "KEEP_OBSERVING";
  if (/可|回购|补充/.test(source)) return "REPURCHASE";
  return "UNDECIDED";
}

function plausibleLocation(source: string | null) {
  if (!source) return false;
  return source.length <= 30 && !/[，。！？；]|不错|舒服|好用|质量|体验/.test(source);
}

function normalizeColor(source: string | null) {
  if (!source) return null;
  if (source === "黑") return "黑色";
  if (source === "白") return "白色";
  return source;
}

function booleanFromSource(source: string) {
  if (!source) return null;
  if (["是", "有"].includes(source)) return true;
  if (["否", "无"].includes(source)) return false;
  return null;
}

function triStateBoolean(source: string) {
  if (!source || source === "待定") return null;
  return booleanFromSource(source);
}

function normalizeDash(source: string) {
  return source.replace(/[‐‑‒–—―−]/g, "-").trim();
}

function slashToNull(source: string | null) {
  return source === "/" ? null : source;
}

function value(sheet: ParsedWorksheet, row: number, column: number, inheritMerged = false) {
  return sheet.getCell(row, column, inheritMerged)?.value ?? null;
}

function textValue(sheet: ParsedWorksheet, row: number, column: number, inheritMerged = false) {
  return normalizeText(value(sheet, row, column, inheritMerged));
}

function nullableText(sheet: ParsedWorksheet, row: number, column: number, inheritMerged = false) {
  const result = textValue(sheet, row, column, inheritMerged);
  return result || null;
}

function normalizeText(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function isBlank(value: unknown) {
  return value === undefined || value === null || normalizeText(value) === "";
}

function statusFromIssues(issues: ImportIssue[]): StagedRowStatus {
  if (issues.some((issue) => issue.severity === "ERROR")) return "ERROR";
  if (issues.length) return "WARNING";
  return "SUCCESS";
}

function isAccepted(row: StagedRow) {
  return row.status === "SUCCESS" || row.status === "WARNING";
}

function warning(issues: ImportIssue[], code: string, message: string, field?: string) {
  issues.push({ code, message, severity: "WARNING", ...(field ? { field } : {}) });
}

function error(issues: ImportIssue[], code: string, message: string, field?: string) {
  issues.push({ code, message, severity: "ERROR", ...(field ? { field } : {}) });
}

function exclusionMessage(code: string) {
  if (code === "OUT_OF_SCOPE_AFTER_ROW_52") return "库存第53行以后按硬规则排除，原值不写暂存载荷";
  if (code === "FORMULA_ONLY_TAIL") return "资产表仅含计算公式，无业务身份字段";
  return "空行不参与迁移";
}

function countAcceptedByType(rows: StagedRow[]) {
  const counts: Record<StagedRecordType, number> = { GAME: 0, ASSET: 0, INVENTORY: 0 };
  for (const row of rows) if (isAccepted(row)) counts[row.recordType] += 1;
  return counts;
}

function countStagedByType(rows: StagedRow[]) {
  const counts: Record<StagedRecordType, number> = { GAME: 0, ASSET: 0, INVENTORY: 0 };
  for (const row of rows) if (row.status !== "EXCLUDED") counts[row.recordType] += 1;
  return counts;
}

function countStatuses(rows: StagedRow[]) {
  const counts: Record<StagedRowStatus, number> = { SUCCESS: 0, WARNING: 0, ERROR: 0, EXCLUDED: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function countIssues(rows: StagedRow[], images: StagedImage[]) {
  const counts: Record<string, number> = {};
  for (const item of [...rows, ...images]) {
    for (const issue of item.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function reconcile(metric: string, expectedCount: number, actualCount: number, details: Record<string, unknown>): Reconciliation {
  return { metric, expectedCount, actualCount, passed: expectedCount === actualCount, details };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function checksum(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function requireSheet(workbook: ParsedWorkbook, name: string) {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`缺少必需工作表：${name}`);
  return sheet;
}
