// Сборка расширения в extension/dist для «Загрузить распакованное расширение».
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, target: "chrome116", sourcemap: false, legalComments: "none", logLevel: "info" };
await build({ ...common, entryPoints: [join(here, "src/content/index.ts")], outfile: join(out, "content.js"), format: "iife" });
await build({ ...common, entryPoints: [join(here, "src/sidepanel/index.ts")], outfile: join(out, "sidepanel.js"), format: "esm" });
await build({ ...common, entryPoints: [join(here, "src/background.ts")], outfile: join(out, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [join(here, "src/options/index.ts")], outfile: join(out, "options.js"), format: "esm" });
cpSync(join(here, "static"), out, { recursive: true });
