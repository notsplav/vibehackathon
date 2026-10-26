// Помощник «Сверки» для Native Messaging. Браузер запускает его, когда расширение подключается,
// и закрывает stdin при отключении — тогда все запущенные проверки останавливаются.
// Сообщения принимаются только от расширения, указанного в манифесте помощника (allowed_origins).

import { existsSync } from "node:fs";
import type { HostRequest } from "../../shared/host.ts";
import { DEFAULT_OPTIONS, type HostEvent, analyze } from "./pipeline.ts";
import { connect } from "./protocol.ts";

export const HOST_VERSION = 1;

const claudeBin = process.env.CLAUDE_BIN ?? "";
const running = new Map<string, AbortController>();
const MODEL = /^[a-z0-9.\-]{2,60}$/i;

function log(message: string): void {
  process.stderr.write(`[sverka-host] ${message}\n`);
}

const send = connect(process.stdin, process.stdout, handle, () => {
  for (const c of running.values()) c.abort();
  // Даём дочерним процессам claude завершиться по SIGTERM.
  setTimeout(() => process.exit(0), 500);
});

function handle(raw: unknown): void {
  const msg = raw as HostRequest;
  if (msg?.type === "ping") {
    send({ type: "pong", version: HOST_VERSION, claudeBin, claudeFound: !!claudeBin && existsSync(claudeBin), defaults: DEFAULT_OPTIONS });
    return;
  }
  if (msg?.type === "cancel" && typeof msg.id === "string") {
    running.get(msg.id)?.abort();
    return;
  }
  if (msg?.type === "analyze" && typeof msg.id === "string" && msg.article && Array.isArray(msg.article.blocks)) {
    if (running.has(msg.id)) return;
    const controller = new AbortController();
    running.set(msg.id, controller);
    const o = msg.options ?? {};
    const options = {
      ...DEFAULT_OPTIONS,
      claudeBin,
      ...(typeof o.extractModel === "string" && MODEL.test(o.extractModel) ? { extractModel: o.extractModel } : {}),
      ...(typeof o.checkModel === "string" && MODEL.test(o.checkModel) ? { checkModel: o.checkModel } : {}),
      ...(Number.isInteger(o.concurrency) && o.concurrency! >= 1 && o.concurrency! <= 8 ? { concurrency: o.concurrency! } : {}),
    };
    analyze(msg.id, msg.article, options, (e: HostEvent) => send(e), controller.signal)
      .catch((e: unknown) => {
        log(`analysis ${msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        send({ type: "stage", id: msg.id, status: "failed", error: e instanceof Error ? e.message : "Ошибка проверки" });
      })
      .finally(() => running.delete(msg.id));
  }
}
