// Word (.docx) import. A .docx is a zip of XML parts; we read word/document.xml
// (and styles.xml, to know which paragraph styles are headings) with a small
// tag scanner instead of a DOM, so this runs the same in the app and in tests.

import { unzipSync, strFromU8 } from "fflate";
import { newId, newProject } from "./project";
import type { Project, Scene } from "./types";

export interface DocxParagraph {
  /** 1 for Heading 1 and so on; 0 for body text. */
  level: number;
  isTitle: boolean;
  /** Text with *italic* and **bold** markers, the format Scene.text uses. */
  text: string;
  plain: string;
}

export interface DocxImport {
  project: Project;
  chapters: number;
  /** How chapters were found, for the message shown after import. */
  splitBy: "headings" | "chapter-lines" | "none";
}

interface StyleInfo {
  name: string;
  basedOn?: string;
  outline?: number;
  bold?: boolean;
  italic?: boolean;
}

const TAG = /<(\/?)([\w:]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? (m[2] ?? m[3]) : undefined;
}

/** w:b and w:i are on unless w:val says otherwise. */
function toggle(attrs: string) {
  const v = attr(attrs, "w:val");
  return v === undefined || !/^(0|false|off|none)$/i.test(v);
}

function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
}

function readStyles(xml: string): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  let cur: StyleInfo | null = null;
  let id = "";
  let inRPr = false;
  for (const m of xml.matchAll(TAG)) {
    const [, close, tag, attrs = "", selfClose] = m;
    if (!tag) continue;
    if (tag === "w:style") {
      if (close) {
        if (cur && id) styles.set(id, cur);
        cur = null;
      } else {
        id = attr(attrs, "w:styleId") ?? "";
        cur = { name: "" };
        if (selfClose) cur = null;
      }
      continue;
    }
    if (!cur) continue;
    if (tag === "w:rPr") inRPr = !close && !selfClose;
    else if (close) continue;
    else if (tag === "w:name") cur.name = attr(attrs, "w:val") ?? "";
    else if (tag === "w:basedOn") cur.basedOn = attr(attrs, "w:val");
    else if (tag === "w:outlineLvl") cur.outline = parseInt(attr(attrs, "w:val") ?? "9", 10);
    else if (inRPr && tag === "w:b") cur.bold = toggle(attrs);
    else if (inRPr && tag === "w:i") cur.italic = toggle(attrs);
  }
  return styles;
}

/** Heading level of a paragraph style (following basedOn), 0 if it is not a heading. */
function styleLevel(styles: Map<string, StyleInfo>, id: string | undefined, depth = 0): number {
  const s = id ? styles.get(id) : undefined;
  if (!s || depth > 10) {
    // No styles.xml entry: Word's built-in ids are "Heading1".."Heading9".
    const m = id?.match(/^heading\s*(\d)$/i);
    return m ? parseInt(m[1], 10) : 0;
  }
  const named = s.name.match(/^heading\s*(\d)$/i);
  if (named) return parseInt(named[1], 10);
  if (s.outline !== undefined && s.outline < 9) return s.outline + 1;
  return styleLevel(styles, s.basedOn, depth + 1);
}

function isTitleStyle(styles: Map<string, StyleInfo>, id: string | undefined) {
  return !!id && /^title$/i.test(styles.get(id)?.name ?? id);
}

function charStyle(styles: Map<string, StyleInfo>, id: string | undefined) {
  const s = id ? styles.get(id) : undefined;
  return {
    bold: s?.bold ?? (!!s && /^(strong)$/i.test(s.name)),
    italic: s?.italic ?? (!!s && /^(emphasis|book title)$/i.test(s.name)),
  };
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Turn runs into text with *italic* and **bold** markers, keeping spaces outside the markers. */
function inline(runs: Run[]): string {
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged
    .map((r) => {
      const mark = (r.bold ? "**" : "") + (r.italic ? "*" : "");
      if (!mark || !r.text.trim()) return r.text;
      const [, lead, core, trail] = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      return `${lead}${mark}${core}${[...mark].reverse().join("")}${trail}`;
    })
    .join("");
}

/** Read the paragraphs of a .docx, in order, with heading levels and basic formatting. */
export function readDocx(bytes: Uint8Array): DocxParagraph[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === "word/styles.xml" });
  } catch {
    throw new Error("This file isn't a Word .docx. If it's an older .doc, open it in Word and save it as .docx first.");
  }
  if (!files["word/document.xml"]) throw new Error("This file has no Word document inside. Is it a .docx?");
  const styles = files["word/styles.xml"] ? readStyles(strFromU8(files["word/styles.xml"])) : new Map<string, StyleInfo>();
  const xml = strFromU8(files["word/document.xml"]);

  const out: DocxParagraph[] = [];
  // A stack, because text boxes put whole paragraphs inside a run of another paragraph.
  const paras: { style?: string; outline?: number; runs: Run[] }[] = [];
  let run: { bold?: boolean; italic?: boolean; style?: string; hidden?: boolean } | null = null;
  let inPPr = false;
  let inRPr = false;
  let inText = false;
  let skip = 0; // inside deleted text, field codes, and the fallback copy of text boxes

  for (const m of xml.matchAll(TAG)) {
    const [, close, tag, attrs = "", selfClose, chars] = m;
    const para = paras[paras.length - 1];
    if (chars !== undefined) {
      if (inText && !skip && para && run && !run.hidden) {
        const cs = charStyle(styles, run.style);
        para.runs.push({ text: decode(chars), bold: run.bold ?? cs.bold, italic: run.italic ?? cs.italic });
      }
      continue;
    }
    if (!tag) continue;
    if (tag === "w:del" || tag === "w:moveFrom" || tag === "w:instrText" || tag === "w:delText" || tag === "mc:Fallback") {
      if (!selfClose) skip += close ? -1 : 1;
      continue;
    }
    if (tag === "w:p") {
      if (selfClose) continue;
      if (!close) {
        paras.push({ runs: [] });
        continue;
      }
      const p = paras.pop();
      if (!p) continue;
      const text = inline(p.runs).replace(/[ \t ]+\n/g, "\n").trim();
      const plain = p.runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
      const level = p.outline !== undefined && p.outline < 9 ? p.outline + 1 : styleLevel(styles, p.style);
      out.push({ level, isTitle: isTitleStyle(styles, p.style), text, plain });
      continue;
    }
    if (!para) continue;
    if (tag === "w:pPr") inPPr = !close && !selfClose;
    else if (tag === "w:rPr") inRPr = !close && !selfClose;
    else if (tag === "w:r") run = close ? null : {};
    else if (tag === "w:t") inText = !close && !selfClose;
    else if (close) continue;
    else if (inPPr && !inRPr && tag === "w:pStyle") para.style = attr(attrs, "w:val");
    else if (inPPr && !inRPr && tag === "w:outlineLvl") para.outline = parseInt(attr(attrs, "w:val") ?? "9", 10);
    else if (run && inRPr && !inPPr) {
      if (tag === "w:b") run.bold = toggle(attrs);
      else if (tag === "w:i") run.italic = toggle(attrs);
      else if (tag === "w:rStyle") run.style = attr(attrs, "w:val");
      else if (tag === "w:vanish") run.hidden = toggle(attrs);
    } else if (run && !skip && !run.hidden) {
      if (tag === "w:tab") para.runs.push({ text: " ", bold: false, italic: false });
      else if (tag === "w:br" || tag === "w:cr") {
        if (attr(attrs, "w:type") !== "page" && attr(attrs, "w:type") !== "column") para.runs.push({ text: "\n", bold: false, italic: false });
      } else if (tag === "w:noBreakHyphen") para.runs.push({ text: "-", bold: false, italic: false });
    }
  }
  return out;
}

const SCENE_BREAK = /^(?:[*#~•§✱⁂]\s*)+$|^-{3,}$/;
const CHAPTER_LINE = /^(chapter|prologue|epilogue|interlude)\b/i;
const PART_LINE = /^(part|book|act|volume)\s+[\w-]+/i;

function chapterTitle(heading: string) {
  return heading.replace(/^chapter\s+[\w-]+[:.\s–—-]*/i, "").trim() || heading.trim();
}

/**
 * Build a project from a .docx. Chapters come from the shallowest heading
 * level in use (skipping "Part One" style levels), scenes from the next level
 * down and from scene-break lines such as "* * *" or "#". Manuscripts with no
 * heading styles fall back to lines that start "Chapter", "Prologue" or "Epilogue".
 */
export function importDocx(bytes: Uint8Array, fallbackTitle: string): DocxImport {
  const paras = readDocx(bytes);
  const title = paras.find((p) => p.isTitle && p.plain)?.plain;
  const project = newProject(title || fallbackTitle);
  project.scenes = [];

  const levels = [...new Set(paras.filter((p) => p.level && p.plain && !p.isTitle).map((p) => p.level))].sort((a, b) => a - b);
  const isPartLevel = (l: number) => paras.filter((p) => p.level === l && p.plain).every((p) => PART_LINE.test(p.plain));
  const content = levels.filter((l) => !isPartLevel(l));
  const chapterLevel = content[0] ?? 0;
  const sceneLevel = content[1] ?? 0;
  const splitBy: DocxImport["splitBy"] = chapterLevel ? "headings" : paras.some((p) => CHAPTER_LINE.test(p.plain) && p.plain.length < 80) ? "chapter-lines" : "none";

  let chapter = 0;
  let sceneTitle = "";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      const s: Scene = { id: newId(), title: sceneTitle || `Scene ${project.scenes.length + 1}`, chapter: Math.max(chapter, 1), text: buf.join("\n\n"), status: "draft" };
      project.scenes.push(s);
    }
    buf = [];
    sceneTitle = "";
  };

  for (const p of paras) {
    if (!p.plain) continue;
    if (p.isTitle && p.plain === title && !project.scenes.length && !buf.length) continue;
    const isChapter = splitBy === "headings" ? p.level === chapterLevel : splitBy === "chapter-lines" && !p.level && CHAPTER_LINE.test(p.plain) && p.plain.length < 80;
    if (isChapter) {
      flush();
      chapter++;
      sceneTitle = chapterTitle(p.plain);
      continue;
    }
    if (sceneLevel && p.level === sceneLevel) {
      // A scene heading straight after the chapter heading names the first scene.
      if (buf.length) flush();
      sceneTitle = p.plain;
      continue;
    }
    if (p.level) continue; // part headings and deeper levels
    if (SCENE_BREAK.test(p.plain)) {
      flush();
      continue;
    }
    buf.push(p.text);
  }
  flush();
  if (!project.scenes.length) project.scenes.push({ id: newId(), title: "Opening", chapter: 1, text: "", status: "draft" });
  return { project, chapters: new Set(project.scenes.map((s) => s.chapter)).size, splitBy };
}
