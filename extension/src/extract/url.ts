const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|yclid|ysclid|_openstat|from|ref)$/i;

/**
 * Нормализует URL для сравнения: без фрагмента, трекинговых параметров, `www.` и завершающего слэша.
 * Возвращает null для некорректного URL.
 */
export function normalizeUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const query = url.searchParams.toString();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/** Фрагмент URL без `#`, если он есть. */
export function urlFragment(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const i = raw.indexOf("#");
  if (i < 0 || i === raw.length - 1) return null;
  try {
    return decodeURIComponent(raw.slice(i + 1));
  } catch {
    return raw.slice(i + 1);
  }
}
