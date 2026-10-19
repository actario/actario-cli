import { z } from 'zod';

/**
 * A deck, as data (improvement plan C2, 2026-10-14).
 *
 * Two writers, one renderer, so their output can be compared fairly (Jacky's
 * Q4: "do both and compare the quality"):
 *   - the web assembles a spec from a note page or a line note, mechanically,
 *     with no model and no tokens (apps/web/src/lib/deck.ts);
 *   - the user's own agent writes a spec itself, re-telling the work for an
 *     audience, and the plugin's `make_deck` tool renders it on their machine.
 *
 * The renderer only lays text out; it never invents any.
 */

export const zTone = z.enum(['done', 'unverified', 'doing', 'todo', 'parked', 'dropped']);
export type Tone = z.infer<typeof zTone>;

/** XML 1.0 cannot carry control characters (an ANSI escape pasted from a terminal would corrupt the file). */
export const cleanText = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

// Factories, not shared instances: a schema object used twice becomes a $ref in
// the JSON Schema an MCP client sees, and some clients do not resolve those.
// Limits match what a note page may hold (packages/daf limits); the renderer
// clips to what fits on a slide, so the assembled deck never fails on length.
const str = (max: number) => z.string().max(max).transform(cleanText);
const line = () => z.string().trim().min(1).max(2000).transform(cleanText);
const items = () => z.array(line()).max(60).default([]);
const notes = () => z.string().max(8000).transform(cleanText).optional();
const tone = () => z.enum(['done', 'unverified', 'doing', 'todo', 'parked', 'dropped']);

export const zSlide = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conclusion'),
    heading: str(200).optional(),
    lede: str(4000).optional(),
    stoppedAt: str(2000).optional(),
    done: items(),
    todo: items(),
    notes: notes(),
  }),
  z.object({
    kind: z.literal('stages'),
    heading: str(200).optional(),
    stages: z.array(z.object({
      name: z.string().trim().min(1).max(200).transform(cleanText),
      status: str(60),
      tone: tone(),
      brief: str(2000).optional(),
      start: z.number().int().min(0).nullable().optional(),
      end: z.number().int().min(0).nullable().optional(),
    })).min(1).max(40),
    turnCount: z.number().int().min(0).optional(),
    notes: notes(),
  }),
  z.object({
    kind: z.literal('stage'),
    heading: z.string().trim().min(1).max(200).transform(cleanText),
    status: str(60).optional(),
    tone: tone().optional(),
    /** 1–6: the stage's colour, the same as on the web (B2). */
    slot: z.number().int().min(1).max(6).optional(),
    brief: str(2000).optional(),
    left: z.object({ label: str(60), items: items() }),
    right: z.object({ label: str(60), items: items() }).optional(),
    turns: str(40).optional(),
    notes: notes(),
  }),
  z.object({
    kind: z.literal('timeline'),
    heading: str(200).optional(),
    items: z.array(z.object({
      date: str(20),
      title: z.string().trim().min(1).max(300).transform(cleanText),
      brief: str(2000).optional(),
      done: z.number().int().min(0).optional(),
      total: z.number().int().min(0).max(100).optional(),
    })).min(1).max(40),
    notes: notes(),
  }),
  z.object({
    kind: z.literal('bullets'),
    heading: z.string().trim().min(1).max(200).transform(cleanText),
    bullets: z.array(line()).min(1).max(60),
    notes: notes(),
  }),
]);
export type Slide = z.infer<typeof zSlide>;

export const zDeckSpec = z.object({
  title: z.string().trim().min(1).max(300).transform(cleanText),
  subtitle: str(500).optional(),
  /** Small line above the title on the cover. */
  kicker: str(80).optional(),
  lang: z.enum(['zh', 'en']).default('en'),
  /**
   * Who wrote the words: shown small on the cover, so a reader knows which kind of deck this is.
   * 'hosted' (2026-10-18): Actario's own model wrote them (weekly reports, Pro and up).
   */
  author: z.enum(['assembled', 'agent', 'hosted']).default('assembled'),
  slides: z.array(zSlide).min(1).max(40),
});
export type DeckSpec = z.infer<typeof zDeckSpec>;
export type DeckSpecInput = z.input<typeof zDeckSpec>;
