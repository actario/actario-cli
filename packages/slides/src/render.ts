import type PptxGenJSType from 'pptxgenjs';
import { zDeckSpec, type DeckSpec, type DeckSpecInput, type Slide, type Tone } from './spec.ts';

/**
 * DeckSpec → .pptx (improvement plan C2). One renderer for both writers (the
 * web's assembled deck and the agent's own), in the Actario look: dark page,
 * warm-white type, the yellow accent, the six stage colours of the web (B2).
 * 16:9, editable text boxes only -- no images, so the file stays small and
 * every word can be changed in PowerPoint, Keynote or Google Slides.
 */

const C = {
  bg: '121212', panel: '1B1B1B', line: '2E2E2E', ink: 'F4F2EC', muted: '9C9A94', faint: '6B6964',
  accent: 'E0B04A', green: '6FA859', orange: 'E8894F', red: 'D9634F', idle: '5A5A5A',
};
const STAGE = ['5B9CF0', 'A78BFA', '2DD4BF', 'F472B6', 'A3E635', 'FB923C'];
const TONE: Record<Tone, string> = { done: C.green, unverified: C.green, doing: C.accent, todo: C.idle, parked: C.orange, dropped: C.red };

const W = 13.333;
const H = 7.5;
const X = 0.6;
const CW = W - 2 * X;

const LABELS = {
  zh: { conclusion: '結論', stoppedAt: '停在', done: '已完成', todo: '待完成', stages: '各階段', timeline: '對話時間軸', nothing: '無', more: (n: number) => `…還有 ${n} 項`, assembled: '由筆記頁組成 · 未經模型改寫', agent: '由你的 agent 依對話重寫', hosted: '由 Actario AI 依筆記頁改寫' },
  en: { conclusion: 'Conclusion', stoppedAt: 'Stopped at', done: 'Done', todo: 'To do', stages: 'Stages', timeline: 'Conversations', nothing: 'Nothing', more: (n: number) => `…and ${n} more`, assembled: 'Assembled from the note page · no model', agent: 'Written by your agent from the conversation', hosted: 'Rewritten by Actario AI from the note pages' },
} as const;

/**
 * Reading width in "units": a CJK or full-width character is 2, anything else
 * 1 -- close to how much of a line each takes in a proportional font.
 */
export function widthOf(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) || ch.codePointAt(0)! > 0x1FFFF ? 2 : 1;
  return w;
}

/** Clip to `units` of reading width, whitespace collapsed, with an ellipsis. */
export function clip(s: string | undefined | null, units: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  if (widthOf(t) <= units) return t;
  let out = '';
  let w = 0;
  for (const ch of t) {
    const cw = widthOf(ch);
    if (w + cw > units - 1) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}

/** How many units fit on one line of a box `w` inches wide at `size` points (a CJK glyph is about 1 em). */
const perLine = (w: number, size: number) => Math.max(8, Math.floor((w * 144) / size * 0.92));

/** At most `max` items; the rest folded into one "and N more" line. */
function cap(list: string[], max: number, more: (n: number) => string): string[] {
  return list.length <= max ? list : [...list.slice(0, max - 1), more(list.length - max + 1)];
}

/** Markdown marks an agent or a page leaves in text (**bold**, `code`, a trailing (#12–18) pointer). */
export function plain(s: string): string {
  return s.replace(/\*\*|`/g, '').replace(/\s*[(（]#\d{1,5}(?:\s*[–—-]\s*#?\d{1,5})?[)）]\s*$/, '').trim();
}

type Pptx = InstanceType<typeof PptxGenJSType>;
type S = ReturnType<Pptx['addSlide']>;

export async function renderDeck(input: DeckSpecInput): Promise<Buffer> {
  const spec: DeckSpec = zDeckSpec.parse(input);
  // Loaded here, not at the top: every other CLI command imports this package
  // for the schema and should not pay for (or fail on) the renderer.
  const { default: PptxGenJS } = await import('pptxgenjs');
  const L = LABELS[spec.lang];
  const colon = spec.lang === 'zh' ? '：' : ': ';
  const font = spec.lang === 'zh' ? 'Microsoft JhengHei' : 'Calibri';
  const mono = 'Consolas';
  const pptx: Pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.title;
  pptx.company = 'Actario';
  pptx.theme = { headFontFace: font, bodyFontFace: font };
  const total = spec.slides.length + 1;

  const base = (n: number): S => {
    const s = pptx.addSlide();
    s.background = { color: C.bg };
    s.addText('> actario', { x: X, y: H - 0.5, w: 2, h: 0.3, fontFace: mono, fontSize: 10, color: C.faint, margin: 0 });
    s.addText(`${n} / ${total}`, { x: W - X - 1.5, y: H - 0.5, w: 1.5, h: 0.3, fontFace: mono, fontSize: 10, color: C.faint, align: 'right', margin: 0 });
    return s;
  };
  const head = (s: S, kicker: string | null, heading: string | null, swatch?: string) => {
    if (kicker) s.addText(kicker.toUpperCase(), { x: X, y: 0.42, w: CW, h: 0.3, fontFace: font, fontSize: 11, color: C.accent, bold: true, charSpacing: 2, margin: 0 });
    if (heading) {
      if (swatch) s.addShape(pptx.ShapeType.rect, { x: X, y: 0.85, w: 0.09, h: 0.5, fill: { color: swatch }, line: { color: swatch } });
      s.addText(clip(heading, perLine(CW - 2.8, 28)), { x: swatch ? X + 0.22 : X, y: 0.78, w: CW - 2.6, h: 0.65, fontFace: font, fontSize: 28, bold: true, color: C.ink, margin: 0, valign: 'middle' });
    }
  };
  // A list panel, sized to what it holds: items clipped to two lines each,
  // dropped (into "and N more") once the panel would pass `max` inches.
  const fitList = (xs: string[], w: number, size: number, max: number): { shown: string[]; h: number } => {
    const per = perLine(w - 0.75, size);
    const lineH = (size / 72) * 1.25;
    const gap = 10 / 72;
    const heightOf = (ys: string[]) => 1.0 + ys.reduce((n, t) => n + Math.min(2, Math.ceil(widthOf(t) / per)) * lineH + gap, 0);
    let shown = xs.length ? xs.map((t) => clip(plain(t), per * 2)) : [L.nothing];
    for (let keep = Math.min(shown.length, 6); keep >= 1; keep--) {
      const ys = xs.length ? cap(shown, keep < shown.length ? keep : shown.length, L.more) : shown;
      if (heightOf(ys) <= max || keep === 1) { shown = ys; break; }
    }
    return { shown, h: Math.min(max, heightOf(shown)) };
  };
  const list = (s: S, label: string, color: string, fit: { shown: string[]; h: number }, empty: boolean, x: number, y: number, w: number, h: number, size = 20) => {
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: C.panel }, line: { color: C.line, width: 0.75 }, rectRadius: 0.08 });
    s.addText(label, { x: x + 0.3, y: y + 0.24, w: w - 0.6, h: 0.4, fontFace: font, fontSize: 15, bold: true, color, margin: 0 });
    s.addText(fit.shown.map((t, i) => ({
      text: t,
      options: { bullet: empty ? false : { indent: 16 }, color: !empty && !(i === fit.shown.length - 1 && t.startsWith('…')) ? C.ink : C.muted, breakLine: i < fit.shown.length - 1 },
    })), { x: x + 0.3, y: y + 0.75, w: w - 0.6, h: h - 0.95, fontFace: font, fontSize: size, valign: 'top', paraSpaceAfter: 10, margin: 0 });
  };
  /** Two panels side by side (done / to do), the same height; a side with nothing is still shown, unless both are empty. */
  const pair = (s: S, a: { label: string; color: string; items: string[] }, b: { label: string; color: string; items: string[] } | null, y: number, max: number) => {
    if (!b) {
      const f = fitList(a.items, CW, 22, max);
      list(s, a.label, a.color, f, a.items.length === 0, X, y, CW, f.h, 22);
      return;
    }
    if (a.items.length === 0 && b.items.length === 0) return;
    const w = CW / 2 - 0.15;
    const fa = fitList(a.items, w, 20, max), fb = fitList(b.items, w, 20, max);
    const h = Math.max(fa.h, fb.h);
    list(s, a.label, a.color, fa, a.items.length === 0, X, y, w, h);
    list(s, b.label, b.color, fb, b.items.length === 0, X + w + 0.3, y, w, h);
  };
  const chip = (s: S, text: string, tone: Tone | undefined, x: number, y: number, w = 1.9) => {
    const color = tone ? TONE[tone] : C.muted;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.38, fill: { color: C.panel }, line: { color, width: 1 }, rectRadius: 0.19 });
    s.addText(clip(text, 16), { x, y, w, h: 0.38, fontFace: font, fontSize: 13, color, align: 'center', valign: 'middle', margin: 0 });
  };

  // ── cover ──
  {
    const s = base(1);
    s.addShape(pptx.ShapeType.rect, { x: X, y: 2.1, w: 0.1, h: 2.9, fill: { color: C.accent }, line: { color: C.accent } });
    if (spec.kicker) s.addText(spec.kicker.toUpperCase(), { x: X + 0.4, y: 2.15, w: CW - 0.4, h: 0.35, fontFace: font, fontSize: 13, bold: true, color: C.accent, charSpacing: 2, margin: 0 });
    s.addText(clip(spec.title, perLine(CW - 0.4, 40) * 2), { x: X + 0.4, y: 2.6, w: CW - 0.4, h: 1.5, fontFace: font, fontSize: 40, bold: true, color: C.ink, valign: 'top', margin: 0 });
    if (spec.subtitle) s.addText(clip(spec.subtitle, perLine(CW - 0.4, 18)), { x: X + 0.4, y: 4.2, w: CW - 0.4, h: 0.5, fontFace: font, fontSize: 18, color: C.muted, margin: 0 });
    s.addText(spec.author === 'agent' ? L.agent : spec.author === 'hosted' ? L.hosted : L.assembled, { x: X + 0.4, y: 4.75, w: CW - 0.4, h: 0.3, fontFace: font, fontSize: 11, color: C.faint, margin: 0 });
  }

  spec.slides.forEach((sl: Slide, k) => {
    const s = base(k + 2);
    switch (sl.kind) {
      case 'conclusion': {
        head(s, L.conclusion, sl.heading ?? null);
        let y = sl.heading ? 1.6 : 0.95;
        if (sl.stoppedAt) {
          s.addText([{ text: `${L.stoppedAt}${colon}`, options: { bold: true, color: C.accent } }, { text: clip(plain(sl.stoppedAt), perLine(CW, 20) - widthOf(L.stoppedAt) - 3), options: { color: C.ink } }],
            { x: X, y, w: CW, h: 0.5, fontFace: font, fontSize: 20, margin: 0 });
          y += 0.7;
        }
        if (sl.lede) {
          const lede = clip(plain(sl.lede), perLine(CW, 24) * 2);
          const lines = Math.min(2, Math.ceil(widthOf(lede) / perLine(CW, 24)));
          s.addText(lede, { x: X, y, w: CW, h: lines * 0.45 + 0.1, fontFace: font, fontSize: 24, color: C.ink, valign: 'top', margin: 0 });
          y += lines * 0.45 + 0.4;
        }
        pair(s, { label: L.done, color: C.green, items: sl.done }, { label: L.todo, color: C.accent, items: sl.todo }, y, H - 0.8 - y);
        break;
      }
      case 'stages': {
        head(s, L.stages, sl.heading ?? null);
        const top = sl.heading ? 1.75 : 1.1;
        const stages = sl.stages.slice(0, 10);   // ten rows fit; the rest are on their own slides
        const n = stages.length;
        const rh = Math.min(1.1, (H - 0.9 - top) / n);
        const tc = sl.turnCount ?? Math.max(1, ...stages.map((x) => (x.end ?? 0) + 1));
        // The turn track only when stages say where they sit in the conversation.
        const ranged = stages.some((x) => x.start !== null && x.start !== undefined);
        const big = rh >= 0.9;
        stages.forEach((st, i) => {
          const y = top + i * rh;
          const col = STAGE[i % STAGE.length]!;
          s.addShape(pptx.ShapeType.rect, { x: X, y: y + 0.08, w: 0.08, h: rh - 0.18, fill: { color: col }, line: { color: col } });
          s.addText([
            { text: clip(plain(st.name), perLine(5.6, big ? 20 : 16)), options: { bold: true, color: C.ink, fontSize: big ? 20 : 16, breakLine: !!st.brief } },
            ...(st.brief && rh >= 0.62 ? [{ text: clip(plain(st.brief), perLine(5.6, big ? 15 : 12)), options: { color: C.muted, fontSize: big ? 15 : 12 } }] : []),
          ], { x: X + 0.25, y, w: 5.6, h: rh - 0.05, fontFace: font, valign: 'middle', margin: 0 });
          chip(s, st.status, st.tone, X + 6.0, y + (rh - 0.38) / 2);
          const tx = X + 8.2, tw = CW - 8.2;
          if (!ranged) return;
          s.addShape(pptx.ShapeType.roundRect, { x: tx, y: y + rh / 2 - 0.07, w: tw, h: 0.14, fill: { color: C.panel }, line: { color: C.line, width: 0.5 }, rectRadius: 0.07 });
          if (st.start !== null && st.start !== undefined && st.end !== null && st.end !== undefined && tc > 0) {
            const a = Math.min(st.start, tc - 1), b = Math.min(Math.max(st.end, a), tc - 1);
            s.addShape(pptx.ShapeType.roundRect, { x: tx + (a / tc) * tw, y: y + rh / 2 - 0.07, w: Math.max(0.08, ((b + 1 - a) / tc) * tw), h: 0.14, fill: { color: col }, line: { color: col }, rectRadius: 0.07 });
          }
        });
        break;
      }
      case 'stage': {
        const col = sl.slot ? STAGE[(sl.slot - 1) % STAGE.length]! : undefined;
        head(s, null, sl.heading, col);
        if (sl.status) chip(s, sl.status, sl.tone, W - X - 1.9, 0.92);
        if (sl.turns) s.addText(sl.turns, { x: W - X - 4.2, y: 0.92, w: 2.2, h: 0.38, fontFace: mono, fontSize: 12, color: C.faint, align: 'right', valign: 'middle', margin: 0 });
        let y = 1.6;
        if (sl.brief) {
          s.addText(clip(plain(sl.brief), perLine(CW, 24)), { x: X, y, w: CW, h: 0.6, fontFace: font, fontSize: 24, color: C.muted, margin: 0 });
          y += 0.9;
        }
        pair(s, { label: sl.left.label, color: sl.right ? C.green : C.ink, items: sl.left.items },
          sl.right ? { label: sl.right.label, color: C.accent, items: sl.right.items } : null, y, H - 0.8 - y);
        break;
      }
      case 'timeline': {
        head(s, L.timeline, sl.heading ?? null);
        const top = sl.heading ? 1.75 : 1.1;
        const items = sl.items.slice(0, 10);
        const n = items.length;
        const rh = Math.min(1.0, (H - 0.9 - top) / n);
        items.forEach((it, i) => {
          const y = top + i * rh;
          s.addShape(pptx.ShapeType.line, { x: X, y: y + rh, w: CW, h: 0, line: { color: C.line, width: 0.5 } });
          s.addText(it.date, { x: X, y, w: 1.7, h: rh, fontFace: mono, fontSize: 12, color: C.muted, valign: 'middle', margin: 0 });
          s.addText([
            { text: clip(plain(it.title), perLine(7.4, 15)), options: { bold: true, color: C.ink, fontSize: 15, breakLine: !!it.brief } },
            ...(it.brief && rh >= 0.55 ? [{ text: clip(plain(it.brief), perLine(7.4, 12)), options: { color: C.muted, fontSize: 12 } }] : []),
          ], { x: X + 1.8, y, w: 7.4, h: rh, fontFace: font, valign: 'middle', margin: 0 });
          if (it.total) {
            const bx = X + 9.5, bw = CW - 9.5, seg = bw / it.total;
            for (let j = 0; j < it.total; j++) {
              const c = j < (it.done ?? 0) ? C.green : C.idle;
              s.addShape(pptx.ShapeType.rect, { x: bx + j * seg, y: y + rh / 2 - 0.05, w: Math.max(0.02, seg - 0.04), h: 0.1, fill: { color: c }, line: { color: c } });
            }
          }
        });
        break;
      }
      case 'bullets': {
        head(s, null, sl.heading);
        const f = fitList(sl.bullets, CW + 0.6, 20, H - 2.2);
        s.addText(f.shown.map((t, i) => ({ text: t, options: { bullet: { indent: 18 }, breakLine: i < f.shown.length - 1 } })),
          { x: X, y: 1.7, w: CW, h: H - 2.5, fontFace: font, fontSize: 20, color: C.ink, valign: 'top', paraSpaceAfter: 10, margin: 0 });
        break;
      }
    }
    if (sl.notes) s.addNotes(sl.notes);
  });

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}
