import type { Scene, Span } from "./types";

export interface Paragraph {
  sceneId: string;
  index: number;
  /** Content hash, suffixed when a scene repeats the same paragraph. Survives edits elsewhere. */
  hash: string;
  text: string;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

export function segment(scene: Scene): Paragraph[] {
  const seen = new Map<string, number>();
  return splitParagraphs(scene.text).map((text, index) => {
    const base = fnv1a(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { sceneId: scene.id, index, hash: n ? `${base}-${n}` : base, text };
  });
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

/** Sentence boundaries inside a paragraph, tolerant of dialogue and honorifics. */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?]+(?:[.!?]+["”’']?|$)/g;
  let m: RegExpExecArray | null;
  let carry = -1;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    const start = carry >= 0 ? carry : m.index;
    const end = m.index + m[0].length;
    // Don't split after Mr. / Mrs. / Dr. / St.
    if (/\b(Mr|Mrs|Ms|Dr|St)\.$/.test(m[0].trim())) {
      carry = start;
      continue;
    }
    carry = -1;
    out.push({ start, end, text: text.slice(start, end) });
  }
  if (carry >= 0) out.push({ start: carry, end: text.length, text: text.slice(carry) });
  return out;
}

export function makeSpan(p: Paragraph, start: number, end: number): Span {
  return { sceneId: p.sceneId, paraHash: p.hash, start, end, quote: p.text.slice(start, end) };
}

/** Widen a span to the sentence that contains it, for display. */
export function sentenceSpan(p: Paragraph, start: number, end: number): Span {
  const s = sentences(p.text).find((x) => x.start <= start && x.end >= end);
  if (!s) return makeSpan(p, start, end);
  const lead = s.text.length - s.text.trimStart().length;
  return makeSpan(p, s.start + lead, s.start + s.text.trimEnd().length);
}

const SMALL = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export const NUMBER_WORDS = `(?:\\d{1,3}|(?:${TENS.slice(2).join("|")})(?:[- ](?:${SMALL.slice(1, 10).join("|")}))?|${SMALL.slice(1).join("|")}|a hundred)`;

export function parseNumber(s: string): number | null {
  const t = s.toLowerCase().trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t === "a hundred") return 100;
  const small = SMALL.indexOf(t);
  if (small >= 0) return small;
  const [tens, unit] = t.split(/[- ]/);
  const ti = TENS.indexOf(tens);
  if (ti < 2) return null;
  if (!unit) return ti * 10;
  const ui = SMALL.indexOf(unit);
  return ui > 0 && ui < 10 ? ti * 10 + ui : null;
}

/** Write n the way the original was written: digits stay digits, words stay words. */
export function formatNumberLike(n: number, like: string): string {
  if (/^\d/.test(like.trim())) return String(n);
  let w: string;
  if (n < 20) w = SMALL[n];
  else if (n % 10 === 0) w = TENS[n / 10];
  else w = `${TENS[Math.floor(n / 10)]}-${SMALL[n % 10]}`;
  return /^[A-Z]/.test(like) ? w[0].toUpperCase() + w.slice(1) : w;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function yearOf(date?: string): number | null {
  const m = date?.match(/^(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
}
