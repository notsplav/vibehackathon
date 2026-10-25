// Определение служебных областей страницы: навигация, реклама, комментарии, рекомендации и т. п.

const EXCLUDED_TAGS = new Set(["NAV", "ASIDE", "FOOTER", "FORM", "BUTTON", "SELECT", "TEXTAREA", "DIALOG", "MENU"]);
const EXCLUDED_ROLES = new Set(["navigation", "complementary", "banner", "contentinfo", "search", "dialog", "menu", "menubar", "alert"]);

// По мотивам эвристик Readability: служебные классы и id.
const UNLIKELY =
  /(^|[\s_-])(ad|ads|adv|advert|banner|breadcrumbs?|comments?|community|cookie|disqus|gdpr|legal|menu|modal|newsletter|outbrain|pager|pagination|paywall|popup|promo|recommend\w*|related|remark|replies|rss|share|sharings?|shoutbox|sidebar|skyscraper|social|sponsor\w*|subscribe|subscription|taboola|tags|teaser|toolbar|login|signin|signup|widget)([\s_-]|$)/i;
const MAYBE_CONTENT = /article|body|content|main|text|story|post/i;

function marker(el: Element): string {
  return `${el.getAttribute("class") ?? ""} ${el.id}`;
}

/** Служебный ли сам элемент (без учёта предков). */
export function isExcludedElement(el: Element): boolean {
  if (EXCLUDED_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  if (role && EXCLUDED_ROLES.has(role)) return true;
  // Шапка сайта, а не шапка статьи: <header> вне <article> без <h1>.
  if (el.tagName === "HEADER" && !el.closest("article") && !el.querySelector("h1")) return true;
  const m = marker(el);
  return UNLIKELY.test(m) && !MAYBE_CONTENT.test(m);
}

/** Лежит ли элемент внутри служебной области. `stopAt` ограничивает подъём (например, корнем статьи). */
export function isInExcludedRegion(el: Element, stopAt?: Element | null): boolean {
  for (let cur: Element | null = el; cur && cur !== stopAt; cur = cur.parentElement) {
    if (cur.tagName === "BODY" || cur.tagName === "HTML") break;
    if (isExcludedElement(cur)) return true;
  }
  return false;
}
