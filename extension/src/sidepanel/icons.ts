// Глифы для кнопок панели: inline SVG, создаются через DOM без innerHTML.

// Путь с префиксом «solid:» закрашивается, остальные рисуются контуром.
const PATHS = {
  stop: ["solid:M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
  retry: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
} as const;

export type IconName = keyof typeof PATHS;

export function icon(doc: Document, name: IconName): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  for (const spec of PATHS[name]) {
    const path = doc.createElementNS(NS, "path");
    const solid = spec.startsWith("solid:");
    path.setAttribute("d", solid ? spec.slice(6) : spec);
    if (solid) path.setAttribute("class", "solid");
    svg.append(path);
  }
  return svg;
}
