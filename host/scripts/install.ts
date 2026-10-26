// Регистрирует помощника «Сверки» в Chrome и Firefox: npm run install:host (удалить — npm run install:host -- --uninstall).
// Создаёт локальную обёртку host/bin/sverka-host с абсолютными путями к node и claude (браузер запускает
// помощника с урезанным PATH) и манифесты в папках NativeMessagingHosts обоих браузеров. Всё — только на этой машине.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GECKO_ID } from "../../extension/scripts/manifest.ts";

const HOST_NAME = "com.sverka.host";
// ID стабилен благодаря ключу в extension/static/manifest.json.
const EXTENSION_ORIGIN = "chrome-extension://gpmhmgppcnmhmkiiaefegfiboaoagiao/";

const hostDir = resolve(import.meta.dirname, "..");
const wrapper = join(hostDir, "bin", "sverka-host");
const mac = platform() === "darwin";
/** Куда каждый браузер смотрит за манифестами помощников и чем ограничивает доступ к помощнику. */
const browsers = [
  {
    name: "Chrome",
    dir: mac ? join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts") : join(homedir(), ".config/google-chrome/NativeMessagingHosts"),
    access: { allowed_origins: [EXTENSION_ORIGIN] },
  },
  {
    name: "Firefox",
    dir: mac ? join(homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts") : join(homedir(), ".mozilla/native-messaging-hosts"),
    access: { allowed_extensions: [GECKO_ID] },
  },
].map((b) => ({ ...b, path: join(b.dir, `${HOST_NAME}.json`) }));

function findClaude(): string | null {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const r = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" });
  const path = r.stdout.trim();
  return path && existsSync(path) ? path : null;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

if (process.argv.includes("--uninstall")) {
  for (const b of browsers) rmSync(b.path, { force: true });
  rmSync(wrapper, { force: true });
  console.log(`Помощник удалён:\n${browsers.map((b) => `  ${b.name}: ${b.path}`).join("\n")}`);
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

for (const b of browsers) {
  mkdirSync(b.dir, { recursive: true });
  writeFileSync(
    b.path,
    JSON.stringify({ name: HOST_NAME, description: "Сверка: проверка утверждений через Claude Code", path: wrapper, type: "stdio", ...b.access }, null, 2) + "\n",
  );
}

console.log(`Помощник установлен.
  обёртка:  ${wrapper}
${browsers.map((b) => `  ${b.name.padEnd(8)} ${b.path}`).join("\n")}
  claude:   ${claude}
  node:     ${process.execPath}
Перезагрузите расширение: chrome://extensions или about:debugging в Firefox.`);
