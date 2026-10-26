// Content script: внедряется по действию пользователя (activeTab + scripting).
// Хранит соответствие blockId → элемент живой страницы; на сервер уходит только сериализуемая статья.

import type { Claim } from "../../../shared/contract.ts";
import { textFingerprint } from "../extract/blocks.ts";
import { extractArticle } from "../extract/index.ts";
import { visibleText } from "../extract/text.ts";
import type { ExtractReply, PanelMessage, RenderReply } from "../messages.ts";
import { ext } from "../platform.ts";
import { type BlockInfo, closeCard, openCard } from "./card.ts";
import { STATUS_ATTR, applyMarkers, claimsByBlock, clearMarkers } from "./markers.ts";
import { selectionArticle } from "./selection.ts";

interface ContentState {
  elements: Map<string, Element>;
  /** Тип и порядок блоков: карточка знает, где утверждение встретилось впервые. */
  blocks: Map<string, BlockInfo>;
  fingerprint: string;
  claims: Claim[];
}

/** Состояние текущей страницы; content script может внедряться повторно, поэтому оно живёт в window. */
type WindowWithState = Window & { __vhFactcheck?: { state: ContentState | null } };

export function currentFingerprint(elements: Map<string, Element>): string | null {
  const texts: string[] = [];
  for (const el of elements.values()) {
    if (!el.isConnected) return null;
    texts.push(visibleText(el));
  }
  return textFingerprint(texts);
}

export function handleMessage(win: WindowWithState, msg: PanelMessage): ExtractReply | RenderReply | { ok: true } {
  const holder = (win.__vhFactcheck ??= { state: null });
  const doc = win.document;
  switch (msg.type) {
    case "vh:extract": {
      clearMarkers(doc);
      closeCard(doc);
      const { article, elements, fingerprint } = extractArticle(doc, win.location.href);
      holder.state = { elements, fingerprint, claims: [], blocks: new Map(article.blocks.map((b) => [b.id, { type: b.type, order: b.order }])) };
      return { ok: true, article, fingerprint };
    }
    case "vh:extract-selection": {
      clearMarkers(doc);
      closeCard(doc);
      const result = selectionArticle(win, msg.hint, msg.onlyHint === true);
      if (!result.ok) return result;
      holder.state = {
        elements: result.elements,
        fingerprint: result.fingerprint,
        claims: [],
        blocks: new Map(result.article.blocks.map((b) => [b.id, { type: b.type, order: b.order }])),
      };
      return { ok: true, article: result.article, fingerprint: result.fingerprint };
    }
    case "vh:render": {
      const state = holder.state;
      if (!state || state.fingerprint !== msg.fingerprint) return { ok: true, stale: true, marked: 0 };
      // Если текст страницы изменился, старый результат к новому тексту не привязываем.
      if (currentFingerprint(state.elements) !== state.fingerprint) {
        clearMarkers(doc);
        closeCard(doc);
        return { ok: true, stale: true, marked: 0 };
      }
      state.claims = msg.claims;
      return { ok: true, stale: false, marked: applyMarkers(state.elements, msg.claims) };
    }
    case "vh:focus": {
      const el = holder.state?.elements.get(msg.blockId);
      if (!el || !holder.state) return { ok: false, error: "Блок не найден на странице" };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const claims = claimsByBlock(holder.state.claims).get(msg.blockId) ?? [];
      const blocks = holder.state.blocks;
      if (claims.length > 0) setTimeout(() => openCard(el, msg.blockId, claims, blocks), 350);
      return { ok: true };
    }
    case "vh:clear": {
      clearMarkers(doc);
      closeCard(doc);
      holder.state = null;
      return { ok: true };
    }
  }
}

/** Клик по помеченному блоку открывает карточку; клики по ссылкам и выделение текста не перехватываются. */
export function handleClick(win: WindowWithState, event: MouseEvent): void {
  const target = event.target as Element | null;
  if (!target || target.closest("#vh-factcheck-card")) return;
  closeCard(win.document);
  if (target.closest("a, button, input, textarea, select, label, [contenteditable]")) return;
  if ((win.getSelection?.()?.toString() ?? "").trim().length > 0) return;
  const block = target.closest(`[${STATUS_ATTR}]`);
  const state = win.__vhFactcheck?.state;
  if (!block || !state) return;
  for (const [blockId, el] of state.elements) {
    if (el !== block) continue;
    const claims = claimsByBlock(state.claims).get(blockId) ?? [];
    if (claims.length > 0) openCard(el, blockId, claims, state.blocks);
    return;
  }
}

function install(win: WindowWithState): void {
  const flagged = win as WindowWithState & { __vhInstalled?: boolean };
  if (flagged.__vhInstalled) return;
  flagged.__vhInstalled = true;
  ext.runtime.onMessage.addListener((msg: PanelMessage, _sender, sendResponse) => {
    try {
      sendResponse(handleMessage(win, msg));
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  win.document.addEventListener("click", (e) => handleClick(win, e), true);
  win.document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCard(win.document);
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) install(window as WindowWithState);
