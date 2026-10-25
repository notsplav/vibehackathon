// Карточка проверки, привязанная к абзацу: открывается под ним, по его ширине, и прокручивается вместе со страницей.
// Shadow DOM защищает от CSS сайта; текст модели вставляется только через textContent.

import type { BlockType, Claim } from "../../../shared/contract.ts";
import { type DisplayState, LABELS, displayState } from "../labels.ts";
import { clearHighlight, highlightFragment } from "./highlight.ts";

const HOST_ID = "vh-factcheck-card";

export interface BlockInfo {
  type: BlockType;
  order: number;
}

/** От проблемных к подтверждённым: сначала то, что важнее прочитать. */
const SEVERITY: DisplayState[] = ["contradicted", "disputed", "qualified", "insufficient", "failed", "checking", "queued", "supported", "not_checked", "opinion"];

const WHERE: Partial<Record<BlockType, string>> = { title: "в заголовке", subtitle: "в подзаголовке", heading: "в подзаголовке раздела" };

const CSS = `
:host{all:initial}
.card{position:relative;box-sizing:border-box;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;
  box-shadow:0 10px 30px rgba(0,0,0,.18);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-height:75vh;overflow:auto}
.card::before{content:"";position:absolute;top:-7px;left:24px;width:12px;height:12px;background:inherit;border-left:1px solid #d0d7de;border-top:1px solid #d0d7de;transform:rotate(45deg)}
@media (prefers-color-scheme: dark){.card{background:#161b22;color:#e6edf3;border-color:#30363d}.card::before{border-color:#30363d}}
header{position:sticky;top:0;z-index:1;background:inherit;display:flex;align-items:flex-start;gap:8px;padding:12px 14px 10px;border-bottom:1px solid rgba(127,127,127,.2);border-radius:10px 10px 0 0}
.head{flex:1}
.title{font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
button.close{font:inherit;border:0;background:transparent;color:inherit;cursor:pointer;font-size:20px;line-height:1;padding:0 4px;border-radius:6px}
button.close:focus-visible,summary:focus-visible{outline:2px solid #0969da;outline-offset:2px}
.list{padding:4px 14px 10px}
details{border-bottom:1px solid rgba(127,127,127,.18)}
details:last-child{border-bottom:0}
summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:9px 0}
summary::-webkit-details-marker{display:none}
summary .icon{font-weight:700;width:1.2em;text-align:center}
summary .text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
details[open] summary .text{display:block}
summary .chev{color:#8c959f;transition:transform .15s}
details[open] summary .chev{transform:rotate(90deg)}
.body{padding:0 0 10px 1.2em;margin-left:8px}
.label{font-size:12px;font-weight:600;margin-bottom:4px}
.fragment{color:#57606a;font-size:13px;border-left:3px solid rgba(255,213,79,.9);padding-left:8px;margin:6px 0}
.expl{margin:6px 0}
.sources{margin:6px 0 0;padding-left:18px}
.sources li{margin:2px 0}
a{color:#0969da;word-break:break-word}
.meta{color:#57606a;font-size:12px}
.section{font-size:12px;font-weight:600;color:#57606a;text-transform:uppercase;letter-spacing:.03em;margin:12px 0 2px}
.s-supported{color:#1a7f37}.s-contradicted{color:#cf222e}.s-qualified{color:#9a6700}.s-disputed{color:#8250df}
.s-insufficient,.s-queued,.s-checking,.s-failed,.s-not_checked,.s-opinion{color:#57606a}
@media (prefers-color-scheme: dark){.fragment,.meta,.section{color:#8d96a0}a{color:#4493f8}.s-supported{color:#3fb950}.s-contradicted{color:#f85149}.s-qualified{color:#d29922}.s-disputed{color:#a371f7}}
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

const cleanups = new WeakMap<Element, () => void>();

export function closeCard(doc: Document): void {
  const host = doc.getElementById(HOST_ID);
  if (host) {
    cleanups.get(host)?.();
    host.remove();
  }
  clearHighlight(doc);
}

/** Блок, где утверждение встречается впервые (по порядку чтения). */
function firstBlock(claim: Claim, blocks: Map<string, BlockInfo>): string {
  let best = claim.occurrences[0]?.blockId ?? claim.blockIds[0]!;
  for (const o of claim.occurrences) if ((blocks.get(o.blockId)?.order ?? 1e9) < (blocks.get(best)?.order ?? 1e9)) best = o.blockId;
  return best;
}

function bySeverity(a: Claim, b: Claim): number {
  return SEVERITY.indexOf(displayState(a)) - SEVERITY.indexOf(displayState(b));
}

export interface CardGroups {
  own: Claim[];
  repeats: { claim: Claim; where: string }[];
  opinions: Claim[];
}

/** Делит claims блока: свои (впервые здесь), повторы из блоков выше и мнения. */
export function groupClaims(blockId: string, claims: Claim[], blocks: Map<string, BlockInfo>): CardGroups {
  const groups: CardGroups = { own: [], repeats: [], opinions: [] };
  for (const c of claims) {
    if (c.status === "opinion") {
      groups.opinions.push(c);
      continue;
    }
    const first = firstBlock(c, blocks);
    if (first === blockId) groups.own.push(c);
    else groups.repeats.push({ claim: c, where: WHERE[blocks.get(first)?.type ?? "paragraph"] ?? "выше в тексте" });
  }
  groups.own.sort(bySeverity);
  groups.repeats.sort((a, b) => bySeverity(a.claim, b.claim));
  return groups;
}

function fragmentFor(claim: Claim, blockId: string): string {
  return claim.occurrences.find((o) => o.blockId === blockId)?.exactText ?? claim.exactText;
}

function claimItem(doc: Document, claim: Claim, blockId: string, open: boolean, target: Element, note?: string): HTMLDetailsElement {
  const state = displayState(claim);
  const label = LABELS[state];
  const details = el(doc, "details");
  details.open = open;
  const summary = el(doc, "summary");
  summary.append(el(doc, "span", `icon s-${state}`, label.icon || "•"), el(doc, "span", "text", claim.normalizedClaim), el(doc, "span", "chev", "›"));
  summary.title = label.text;
  details.append(summary);

  const body = el(doc, "div", "body");
  body.append(el(doc, "div", `label s-${state}`, note ? `${label.text} · ${note}` : label.text));
  const fragment = fragmentFor(claim, blockId);
  body.append(el(doc, "div", "fragment", `«${fragment}»`));
  if (claim.explanation) body.append(el(doc, "p", "expl", claim.explanation));
  if (claim.status === "failed" && claim.error) body.append(el(doc, "p", "expl", claim.error));
  const sources = claim.evidence.map((s) => ({ s, href: safeHref(s.url) })).filter((x) => x.href).slice(0, 3);
  if (sources.length > 0) {
    const list = el(doc, "ol", "sources");
    for (const { s, href } of sources) {
      const li = el(doc, "li");
      const host = hostname(s.url);
      const a = el(doc, "a", undefined, s.title && s.title !== host ? `${s.title} — ${host}` : host);
      a.href = href!;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.append(a);
      if (s.relation) li.append(el(doc, "div", "meta", s.relation));
      list.append(li);
    }
    body.append(list);
  } else if (claim.status === "checked") {
    body.append(el(doc, "div", "meta", "Подходящих источников поиск не нашёл."));
  }
  if (claim.checkedAt) body.append(el(doc, "div", "meta", `Проверено: ${new Date(claim.checkedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`));
  details.append(body);

  // Наведение и раскрытие подсвечивают фрагмент утверждения прямо в абзаце.
  const show = () => highlightFragment(target, fragment);
  details.addEventListener("mouseenter", show);
  details.addEventListener("focusin", show);
  details.addEventListener("toggle", () => details.open && show());
  return details;
}

function chips(doc: Document, claims: Claim[]): HTMLElement {
  const counts = new Map<DisplayState, number>();
  for (const c of claims) counts.set(displayState(c), (counts.get(displayState(c)) ?? 0) + 1);
  const row = el(doc, "div", "chips");
  for (const state of SEVERITY) {
    const n = counts.get(state);
    if (n) row.append(el(doc, "span", `chip s-${state}`, `${LABELS[state].icon} ${LABELS[state].text.toLowerCase()}${n > 1 ? `: ${n}` : ""}`.trim()));
  }
  return row;
}

function place(host: HTMLElement, target: Element): void {
  const view = target.ownerDocument.defaultView;
  const rect = target.getBoundingClientRect();
  const viewport = view?.innerWidth ?? 800;
  const width = Math.min(Math.max(rect.width, 360), 640, viewport - 16);
  const left = Math.max(8, Math.min(rect.left, viewport - width - 8)) + (view?.scrollX ?? 0);
  host.style.cssText = `position:absolute;z-index:2147483647;top:${rect.bottom + (view?.scrollY ?? 0) + 10}px;left:${left}px;width:${width}px`;
}

/** Открывает карточку для блока под ним. */
export function openCard(target: Element, blockId: string, claims: Claim[], blocks: Map<string, BlockInfo>): void {
  const doc = target.ownerDocument;
  closeCard(doc);
  const groups = groupClaims(blockId, claims, blocks);
  const checkable = [...groups.own, ...groups.repeats.map((r) => r.claim)];

  const host = doc.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  const style = el(doc, "style");
  style.textContent = CSS;
  const card = el(doc, "section", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Проверка утверждений абзаца");

  const header = el(doc, "header");
  const head = el(doc, "div", "head");
  const n = checkable.length;
  head.append(el(doc, "div", "title", n === 0 ? "Проверяемых утверждений нет" : n === 1 ? "1 утверждение в этом блоке" : `${n} ${n < 5 ? "утверждения" : "утверждений"} в этом блоке`));
  if (n > 0) head.append(chips(doc, checkable));
  const close = el(doc, "button", "close", "×");
  close.setAttribute("aria-label", "Закрыть");
  close.addEventListener("click", () => closeCard(doc));
  header.append(head, close);
  card.append(header);

  const list = el(doc, "div", "list");
  // Раскрыто первое (самое важное) утверждение; если утверждение одно — оно.
  groups.own.forEach((c, i) => list.append(claimItem(doc, c, blockId, i === 0, target)));
  if (groups.repeats.length) {
    list.append(el(doc, "div", "section", "Уже встречалось выше"));
    for (const r of groups.repeats) list.append(claimItem(doc, r.claim, blockId, groups.own.length === 0 && r === groups.repeats[0], target, `впервые ${r.where}`));
  }
  if (groups.opinions.length) {
    list.append(el(doc, "div", "section", "Мнения — не проверяются"));
    for (const c of groups.opinions) list.append(claimItem(doc, c, blockId, false, target));
  }
  card.append(list);
  root.append(style, card);
  doc.documentElement.append(host);

  place(host, target);
  const view = doc.defaultView;
  const onResize = () => place(host, target);
  view?.addEventListener("resize", onResize);
  cleanups.set(host, () => view?.removeEventListener("resize", onResize));

  const firstOpen = groups.own[0] ?? groups.repeats[0]?.claim;
  if (firstOpen) highlightFragment(target, fragmentFor(firstOpen, blockId));
  // Карточка целиком в поле зрения, но абзац над ней не уезжает без нужды.
  card.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  close.focus({ preventScroll: true });
}
