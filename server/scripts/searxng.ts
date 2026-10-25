// Локальный SearXNG в Docker: npm run searxng:up | searxng:down | searxng:status.
// Порт публикуется только на 127.0.0.1; secret_key генерируется при каждом запуске и нигде не сохраняется.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const IMAGE = "searxng/searxng:2026.9.30-a9d990033";
const NAME = "vibehackathon-searxng";
const url = new URL(process.env.SEARXNG_URL || "http://127.0.0.1:8888");
const port = url.port || "80";
const configDir = resolve(import.meta.dirname, "../../searxng");

function docker(args: string[], quiet = false): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.error) {
    console.error("Docker не найден. Установите OrbStack (brew install --cask orbstack) или Docker Desktop и запустите его.");
    process.exit(1);
  }
  if (!quiet && r.status !== 0) console.error(r.stderr.trim());
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

async function waitReady(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(new URL("/search?q=test&format=json", url), { signal: AbortSignal.timeout(2000) });
      if (res.status === 403) {
        console.error("SearXNG отвечает 403 на JSON: конфигурация searxng/settings.yml не применилась.");
        return false;
      }
      if (res.ok) return true;
    } catch {
      // ещё запускается
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const command = process.argv[2] ?? "status";
if (command === "up") {
  docker(["rm", "-f", NAME], true);
  const run = docker([
    "run", "-d", "--name", NAME, "--restart", "unless-stopped",
    "-p", `127.0.0.1:${port}:8080`,
    "-v", `${configDir}:/etc/searxng:ro`,
    "-e", `SEARXNG_SECRET=${randomBytes(32).toString("hex")}`,
    "-e", `SEARXNG_BASE_URL=${url.origin}/`,
    IMAGE,
  ]);
  if (!run.ok) process.exit(1);
  process.stdout.write(`SearXNG запускается на ${url.origin} … `);
  console.log((await waitReady()) ? "готов." : "не ответил за 40 с: npm run searxng:status и docker logs " + NAME);
} else if (command === "down") {
  docker(["rm", "-f", NAME]);
  console.log("SearXNG остановлен.");
} else {
  const ps = docker(["ps", "--filter", `name=${NAME}`, "--format", "{{.Status}}"], true);
  console.log(ps.out ? `контейнер: ${ps.out}` : "контейнер не запущен (npm run searxng:up)");
  try {
    const res = await fetch(new URL("/search?q=%D0%9C%D0%B0%D1%80%D0%B8%D1%8F%20%D0%9A%D1%8E%D1%80%D0%B8&format=json", url), { signal: AbortSignal.timeout(15000) });
    const data = res.ok ? ((await res.json()) as { results?: { url: string }[]; unresponsive_engines?: unknown[] }) : null;
    console.log(res.ok ? `поиск: ${data?.results?.length ?? 0} результатов; недоступные движки: ${JSON.stringify(data?.unresponsive_engines ?? [])}` : `поиск: HTTP ${res.status}`);
  } catch {
    console.log(`поиск: ${url.origin} не отвечает`);
  }
}
