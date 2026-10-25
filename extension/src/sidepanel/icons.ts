// Глифы для кнопок панели: inline SVG, создаются через DOM без innerHTML.

const PATHS = {
  stop: ["M6.5 6.5h11v11h-11z"],
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
  for (const d of PATHS[name]) {
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
