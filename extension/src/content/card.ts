// Карточка проверки в Shadow DOM: CSS сайта её не ломает, а текст модели вставляется
// только через textContent, без innerHTML.

import type { Claim } from "../../../shared/contract.ts";
import { LABELS, displayState } from "../labels.ts";

const HOST_ID = "vh-factcheck-card";

const CSS = `
:host{all:initial}
.card{position:fixed;z-index:2147483647;max-width:420px;max-height:min(70vh,560px);overflow:auto;box-sizing:border-box;
  background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 14px}
@media (prefers-color-scheme: dark){.card{background:#161b22;color:#e6edf3;border-color:#30363d}}
header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;font-weight:600}
button{font:inherit;border:0;background:transparent;color:inherit;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}
button:focus-visible{outline:2px solid #0969da}
.claim{border-top:1px solid rgba(127,127,127,.25);padding:8px 0}
.claim:first-of-type{border-top:0}
.badge{display:inline-block;font-weight:600;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid currentColor;margin-bottom:4px}
.s-supported{color:#1a7f37}.s-contradicted{color:#cf222e}.s-qualified{color:#9a6700}.s-disputed{color:#8250df}
.s-insufficient,.s-queued,.s-checking,.s-failed,.s-not_checked,.s-opinion{color:#57606a}
.fragment{color:#57606a;font-size:13px;margin:4px 0}
.expl{margin:4px 0}
ul{margin:4px 0 0;padding-left:18px}
a{color:#0969da;word-break:break-word}
.meta{color:#57606a;font-size:12px;margin-top:4px}
`;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function closeCard(doc: Document): void {
  doc.getElementById(HOST_ID)?.remove();
}

/** Показывает карточку для claims блока рядом с элементом. */
export function openCard(target: Element, claims: Claim[], blockId: string): void {
  const doc = target.ownerDocument;
  closeCard(doc);
  const host = doc.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  const style = el(doc, "style");
  style.textContent = CSS;
  const card = el(doc, "section", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Проверка утверждений");

  const header = el(doc, "header");
  const checkable = claims.filter((c) => c.status !== "opinion");
  header.append(el(doc, "span", undefined, checkable.length > 1 ? `Утверждений в блоке: ${checkable.length}` : "Проверка утверждения"));
  const close = el(doc, "button", undefined, "×");
  close.setAttribute("aria-label", "Закрыть");
  close.addEventListener("click", () => closeCard(doc));
  header.append(close);
  card.append(header);

  for (const claim of claims) {
    const state = displayState(claim);
    const item = el(doc, "article", "claim");
    const label = LABELS[state];
    item.append(el(doc, "span", `badge s-${state}`, `${label.icon ? `${label.icon} ` : ""}${label.text}`));
    item.append(el(doc, "div", undefined, claim.normalizedClaim));
    const fragment = claim.occurrences.find((o) => o.blockId === blockId)?.exactText ?? claim.exactText;
    item.append(el(doc, "div", "fragment", `Фрагмент: «${fragment}»`));
    if (claim.explanation) item.append(el(doc, "p", "expl", claim.explanation));
    if (claim.status === "failed" && claim.error) item.append(el(doc, "p", "expl", claim.error));
    const sources = claim.evidence.slice(0, 3);
    if (sources.length > 0) {
      const list = el(doc, "ul");
      for (const s of sources) {
        const href = safeHref(s.url);
        if (!href) continue;
        const li = el(doc, "li");
        const a = el(doc, "a", undefined, s.title && s.title !== hostname(s.url) ? `${s.title} — ${hostname(s.url)}` : hostname(s.url));
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.append(a);
        if (s.relation) li.append(el(doc, "div", "meta", s.relation));
        list.append(li);
      }
      item.append(list);
    }
    if (claim.checkedAt) item.append(el(doc, "div", "meta", `Проверено: ${new Date(claim.checkedAt).toLocaleString("ru-RU")}`));
    card.append(item);
  }

  root.append(style, card);
  (doc.body ?? doc.documentElement).append(host);

  // Положение: под блоком, в пределах окна.
  const rect = target.getBoundingClientRect();
  const view = doc.defaultView;
  const width = Math.min(420, (view?.innerWidth ?? 800) - 16);
  const left = Math.max(8, Math.min(rect.left, (view?.innerWidth ?? 800) - width - 8));
  const below = rect.bottom + 8;
  const top = below + 200 < (view?.innerHeight ?? 800) ? below : Math.max(8, rect.top - 8 - Math.min(400, rect.top));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.width = `${width}px`;
  close.focus();
}
