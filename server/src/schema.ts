// Проверка входящего ExtractedArticle. Строки статьи — недоверенный ввод: ограничиваем размеры и формат.

import { z } from "zod";
import { SCHEMA_VERSION } from "../../shared/contract.ts";

const MAX_BLOCKS = 3000;
const MAX_BLOCK_TEXT = 20_000;

const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), "ожидается http(s) URL");

const quality = z.enum(["confirmed", "plausible", "unknown"]);
const sourced = z.object({ value: z.string().max(100), source: z.string().max(100), quality }).nullable();

export const extractedArticleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  url: httpUrl,
  canonicalUrl: httpUrl.nullable(),
  language: z.string().max(20).nullable(),
  pageType: z.enum(["article", "unknown"]),
  metadata: z.object({
    title: z.string().max(2000).nullable(),
    subtitle: z.string().max(4000).nullable(),
    authors: z
      .array(
        z.object({
          name: z.string().max(300),
          type: z.enum(["person", "organization"]),
          url: z.string().max(2048).optional(),
          source: z.string().max(100),
          quality,
        }),
      )
      .max(50),
    publishedAt: sourced,
    modifiedAt: sourced,
  }),
  blocks: z
    .array(
      z.object({
        id: z.string().regex(/^b\d{1,5}$/),
        type: z.enum(["title", "subtitle", "heading", "paragraph", "list_item", "quote", "caption"]),
        order: z.number().int().min(1),
        text: z.string().max(MAX_BLOCK_TEXT),
        links: z.array(z.object({ href: z.string().max(4096), text: z.string().max(2000) })).max(200),
        parentBlockId: z.string().regex(/^b\d{1,5}$/).optional(),
      }),
    )
    .max(MAX_BLOCKS),
  focus: z
    .object({
      blockIds: z.array(z.string().regex(/^b\d{1,5}$/)).min(1).max(50),
      text: z.string().min(3).max(8000),
    })
    .nullable()
    .optional(),
  extraction: z.object({
    status: z.enum(["ok", "failed"]),
    method: z.string().max(100),
    warnings: z.array(z.string().max(1000)).max(200),
    error: z.object({ code: z.enum(["not_article", "empty_page", "low_confidence"]), message: z.string().max(1000) }).optional(),
  }),
});

export type ValidatedArticle = z.infer<typeof extractedArticleSchema>;
