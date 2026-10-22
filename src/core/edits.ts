import { segment, splitParagraphs } from "./text";
import type { Edit, Project, Scene, Span, Suggestion } from "./types";

/** Find where a span sits in its scene now: paragraph index and offsets, re-anchored on the quote if text moved. */
export function locate(scene: Scene, span: Span): { para: number; start: number; end: number } | null {
  const paras = segment(scene);
  const p = paras.find((x) => x.hash === span.paraHash);
  if (!p) {
    // The paragraph changed; fall back to the first paragraph that still holds the quote.
    for (const q of paras) {
      const i = q.text.indexOf(span.quote);
      if (i >= 0) return { para: q.index, start: i, end: i + span.quote.length };
    }
    return null;
  }
  if (p.text.slice(span.start, span.end) === span.quote) return { para: p.index, start: span.start, end: span.end };
  const i = p.text.indexOf(span.quote);
  return i >= 0 ? { para: p.index, start: i, end: i + span.quote.length } : null;
}

/** Apply a suggestion's edits to the project. Returns the previous scene texts for undo. */
export function applySuggestion(project: Project, s: Suggestion): { before: Scene[]; applied: number; skipped: number } {
  const before: Scene[] = [];
  let applied = 0;
  let skipped = 0;
  const bySceneId = new Map<string, Edit[]>();
  for (const e of s.edits) bySceneId.set(e.span.sceneId, [...(bySceneId.get(e.span.sceneId) ?? []), e]);
  const touched = new Set([...bySceneId.keys(), ...(s.meta ? [s.meta.sceneId] : [])]);
  for (const id of touched) {
    const scene = project.scenes.find((x) => x.id === id);
    if (scene) before.push({ ...scene });
  }
  for (const [id, edits] of bySceneId) {
    const scene = project.scenes.find((x) => x.id === id);
    if (!scene) {
      skipped += edits.length;
      continue;
    }
    const paras = splitParagraphs(scene.text);
    const located = edits
      .map((e) => ({ e, at: locate(scene, e.span) }))
      .filter((x) => {
        if (!x.at) skipped++;
        return !!x.at;
      })
      // Apply right-to-left so earlier offsets stay valid.
      .sort((a, b) => b.at!.para - a.at!.para || b.at!.start - a.at!.start);
    for (const { e, at } of located) {
      const t = paras[at!.para];
      paras[at!.para] = t.slice(0, at!.start) + e.replacement + t.slice(at!.end);
      applied++;
    }
    scene.text = paras.join("\n\n");
  }
  if (s.meta) {
    const scene = project.scenes.find((x) => x.id === s.meta!.sceneId);
    if (scene) {
      scene[s.meta.field] = s.meta.value;
      applied++;
    }
  }
  return { before, applied, skipped };
}

export function restoreScenes(project: Project, before: Scene[]) {
  for (const b of before) {
    const i = project.scenes.findIndex((s) => s.id === b.id);
    if (i >= 0) project.scenes[i] = { ...b };
  }
}
