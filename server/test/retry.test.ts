import { expect, test } from "vitest";
import { withRetry } from "../src/gemini/client.ts";
import { classifyError } from "../src/gemini/errors.ts";

const fast = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 };

test("503 повторяется и затем проходит", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("high demand"), { status: 503 });
    return "ok";
  }, fast, null);
  expect(result).toBe("ok");
  expect(calls).toBe(3);
});

test("400 не повторяется", async () => {
  let calls = 0;
  await expect(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error("bad"), { status: 400 });
    }, fast, null),
  ).rejects.toMatchObject({ kind: "bad_request" });
  expect(calls).toBe(1);
});

test("429 — rate_limited с подсказкой задержки; ключ вырезается из сообщения", () => {
  const err = classifyError(Object.assign(new Error('quota for key SECRET123. "retryDelay": "37s"'), { status: 429 }), "SECRET123");
  expect(err.kind).toBe("rate_limited");
  expect(err.retryAfterMs).toBe(37_000);
  expect(err.message).not.toContain("SECRET123");
});
