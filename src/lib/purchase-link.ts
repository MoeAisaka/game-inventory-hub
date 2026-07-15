const TRAILING_URL = /(?:\s|[|｜;,，；])+(https?:\/\/[^\s|｜;,，；]+)\s*$/iu;

function normalizedUrl(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function splitProductNameAndPurchaseUrl(productName: string, explicitPurchaseUrl?: string | null) {
  const explicit = normalizedUrl(explicitPurchaseUrl);
  const trimmedName = productName.trim();
  if (explicit) return { productName: trimmedName, purchaseUrl: explicit, extracted: false };

  const match = trimmedName.match(TRAILING_URL);
  if (!match?.index) return { productName: trimmedName, purchaseUrl: null, extracted: false };
  const purchaseUrl = normalizedUrl(match[1]);
  const nameWithoutUrl = trimmedName.slice(0, match.index).trim();
  if (!purchaseUrl || !nameWithoutUrl) return { productName: trimmedName, purchaseUrl: null, extracted: false };
  return { productName: nameWithoutUrl, purchaseUrl, extracted: true };
}

export const purchaseUrlSchema = {
  maxLength: 2048,
  protocols: ["http:", "https:"] as const
};
