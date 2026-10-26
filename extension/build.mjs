// Сборка расширения: extension/dist — Chrome, extension/dist-firefox — Firefox. Код общий, отличаются манифест
// и формат фонового скрипта (service worker в Chrome, обычный скрипт event page в Firefox).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firefoxManifest } from "./scripts/manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const common = { bundle: true, sourcemap: false, legalComments: "none", logLevel: "warning" };
const baseManifest = JSON.parse(readFileSync(join(here, "static/manifest.json"), "utf8"));

async function target(out, browserTarget, backgroundFormat, manifest) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const opts = { ...common, target: browserTarget };
  await build({ ...opts, entryPoints: [join(here, "src/content/index.ts")], outfile: join(out, "content.js"), format: "iife" });
  await build({ ...opts, entryPoints: [join(here, "src/sidepanel/index.ts")], outfile: join(out, "sidepanel.js"), format: "esm" });
  await build({ ...opts, entryPoints: [join(here, "src/background.ts")], outfile: join(out, "background.js"), format: backgroundFormat });
  cpSync(join(here, "static"), out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`собрано: ${out}`);
}

await target(join(here, "dist"), "chrome116", "esm", baseManifest);
await target(join(here, "dist-firefox"), "firefox128", "iife", firefoxManifest(baseManifest));
