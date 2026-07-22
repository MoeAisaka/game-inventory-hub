const cjkTextPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function hasChineseCatalogText(value: string | null | undefined) {
  return Boolean(value?.trim() && cjkTextPattern.test(value));
}
