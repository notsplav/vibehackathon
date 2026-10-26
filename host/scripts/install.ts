// Регистрирует помощника «Сверки» в Chrome: npm run install:host (удалить — npm run install:host -- --uninstall).
// Создаёт локальную обёртку host/bin/sverka-host с абсолютными путями к node и claude (Chrome запускает
// помощника с урезанным PATH) и манифест в папке NativeMessagingHosts. Оба файла — только на этой машине.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOST_NAME = "com.sverka.host";
// ID стабилен благодаря ключу в extension/static/manifest.json.
const EXTENSION_ORIGIN = "chrome-extension://gpmhmgppcnmhmkiiaefegfiboaoagiao/";

const hostDir = resolve(import.meta.dirname, "..");
const wrapper = join(hostDir, "bin", "sverka-host");
const manifestDir =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    : join(homedir(), ".config/google-chrome/NativeMessagingHosts");
const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

function findClaude(): string | null {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const r = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" });
  const path = r.stdout.trim();
  return path && existsSync(path) ? path : null;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

if (process.argv.includes("--uninstall")) {
  rmSync(manifestPath, { force: true });
  rmSync(wrapper, { force: true });
  console.log(`Помощник удалён: ${manifestPath}`);
  process.exit(0);
}

if (platform() !== "darwin" && platform() !== "linux") {
  console.error("Установка помощника пока поддерживается только на macOS и Linux.");
  process.exit(1);
}

const claude = findClaude();
if (!claude) {
  console.error("Не найден Claude Code (команда claude). Установите его и войдите (claude → /login), затем повторите.");
  process.exit(1);
}

mkdirSync(dirname(wrapper), { recursive: true });
writeFileSync(
  wrapper,
  [
    "#!/bin/sh",
    "# Сгенерировано npm run install:host. Не коммитить: содержит пути этой машины.",
    `export CLAUDE_BIN=${quote(claude)}`,
    `exec ${quote(process.execPath)} ${quote(join(hostDir, "src", "main.ts"))} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);

mkdirSync(manifestDir, { recursive: true });
writeFileSync(
  manifestPath,
  JSON.stringify({ name: HOST_NAME, description: "Сверка: проверка утверждений через Claude Code", path: wrapper, type: "stdio", allowed_origins: [EXTENSION_ORIGIN] }, null, 2) + "\n",
);

console.log(`Помощник установлен.
  обёртка:  ${wrapper}
  манифест: ${manifestPath}
  claude:   ${claude}
  node:     ${process.execPath}
Перезагрузите расширение в chrome://extensions.`);
