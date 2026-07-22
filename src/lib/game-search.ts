import * as OpenCC from "opencc-js";

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

export function normalizeGameSearchText(value: string) {
  return value.replace(/[™®©]/g, "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function gameSearchVariants(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return [...new Set([trimmed, toSimplified(trimmed), toTraditional(trimmed)])];
}

export function normalizeGameSearchAliases(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = normalizeGameSearchText(trimmed);
    if (!trimmed || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}
