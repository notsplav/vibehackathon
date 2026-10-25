// Проверка ключа и реальной формы ответа Gemini Interactions API с Google Search.
// Запуск: npm run probe:gemini. Ключ не печатается; выводятся только структура ответа и ссылки grounding.

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
if (!apiKey) {
  console.error("GEMINI_API_KEY не задан (см. .env.example)");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  return `${err.status ?? ""} ${String(err.message ?? e).replaceAll(apiKey!, "***").slice(0, 400)}`;
}

console.log(`model: ${model}`);

try {
  const pager = await ai.models.list();
  const names: string[] = [];
  for await (const m of pager) if (m.name?.includes("gemini")) names.push(m.name);
  console.log(`models available (${names.length}):`, names.filter((n) => /gemini-3/.test(n)).join(", "));
} catch (e) {
  console.error("models.list failed:", describeError(e));
  process.exit(2);
}

const schema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "contradicted", "qualified", "disputed", "insufficient"] },
    explanation: { type: "string" },
  },
  required: ["verdict", "explanation"],
};

try {
  const started = Date.now();
  const interaction = await ai.interactions.create({
    model,
    input: "Проверь утверждение: «Мария Склодовская-Кюри родилась 7 ноября 1867 года в Варшаве». Ответь JSON.",
    tools: [{ type: "google_search" }],
    response_format: { type: "text", mime_type: "application/json", schema },
    store: false,
  });
  console.log(`interaction ${interaction.id} status=${interaction.status} in ${Date.now() - started} ms`);
  for (const [i, step] of (interaction.steps ?? []).entries()) {
    const s = step as Record<string, unknown>;
    console.log(`step[${i}] type=${String(s.type)} keys=${Object.keys(s).join(",")}`);
    if (s.type === "google_search_call") console.log("   queries:", JSON.stringify((s.arguments as { queries?: string[] })?.queries));
    if (s.type === "model_output") {
      for (const c of (s.content as Record<string, unknown>[]) ?? []) {
        const ann = (c.annotations as Record<string, unknown>[]) ?? [];
        console.log(`   content type=${String(c.type)} textLen=${String(c.text ?? "").length} annotations=${ann.length}`);
        for (const a of ann.slice(0, 5)) console.log("     ", JSON.stringify(a).slice(0, 300));
      }
    }
  }
  console.log("output_text:", (interaction.output_text ?? "").slice(0, 500));
} catch (e) {
  console.error("interactions.create failed:", describeError(e));
  process.exit(3);
}
