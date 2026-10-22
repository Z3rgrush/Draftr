import {
  buildNameIndex,
  countThemes,
  DEFAULT_THEMES,
  discoverEntities,
  entityId,
  extractFacts,
  findMentions,
  findThreads,
  inferGenders,
  type Carry,
} from "./extract";
import { fnv1a, makeSpan, segment, type Paragraph } from "./text";
import type { AiExtraction, Entity, Fact, Mention, PlotThread, Project, RawFact, Scene, StoryModel } from "./types";

/** Scenes in reading order: by chapter, then by their position in the binder. */
export function orderedScenes(project: Project): Scene[] {
  return project.scenes.map((s, i) => ({ s, i })).sort((a, b) => a.s.chapter - b.s.chapter || a.i - b.i).map((x) => x.s);
}

export function factKey(f: Pick<Fact, "entityId" | "attribute" | "value">) {
  return `${f.entityId}|${f.attribute}|${f.value}`;
}

/**
 * Rebuild the story model from the manuscript, the AI results still valid for
 * the current text, and the author's bible edits (which always win).
 */
export function buildModel(project: Project, ai: Record<string, AiExtraction> = {}): StoryModel {
  const scenes = orderedScenes(project);
  const paras: Paragraph[] = scenes.flatMap(segment);
  const liveHashes = new Set(paras.map((p) => `${p.sceneId}:${p.hash}`));

  let entities = discoverEntities(paras, project.bible);
  entities = mergeAiEntities(entities, Object.values(ai), project);

  const idx = buildNameIndex(entities);
  inferGenders(paras, idx);

  const mentions: Mention[] = [];
  const raw: RawFact[] = [];
  const themes: Record<string, Record<string, number>> = {};
  const lexicon = { ...DEFAULT_THEMES, ...project.bible.themes };

  for (const scene of scenes) {
    const carry: Carry = {};
    for (const p of paras.filter((x) => x.sceneId === scene.id)) {
      const ms = findMentions(p, idx);
      mentions.push(...ms.map(({ entityId, span, acting }) => ({ entityId, span, acting })));
      raw.push(...extractFacts(p, idx, ms, carry));
      for (const [theme, n] of Object.entries(countThemes(p, lexicon))) {
        (themes[theme] ??= {})[scene.id] = (themes[theme]?.[scene.id] ?? 0) + n;
      }
    }
  }

  // AI facts survive only while the paragraphs they came from are unchanged.
  for (const x of Object.values(ai)) {
    for (const f of x.facts) if (liveHashes.has(`${f.span.sceneId}:${f.span.paraHash}`)) raw.push(f);
  }

  const pinned = new Set(project.bible.pinned);
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const e = idx.byAlias.get(r.entityName) ?? entities.find((x) => x.name === r.entityName);
    if (!e) continue;
    const key = `${e.id}|${r.attribute}|${r.value}|${r.span.sceneId}|${r.span.paraHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f: Fact = {
      id: "f:" + fnv1a(key + r.span.start),
      entityId: e.id,
      attribute: r.attribute,
      value: r.value,
      span: r.span,
      valueSpan: r.valueSpan,
      confidence: r.confidence,
      source: r.source,
      status: "inferred",
    };
    if (pinned.has(factKey(f))) f.status = "pinned";
    facts.push(f);
  }

  const threads = new Map<string, PlotThread>();
  for (const h of findThreads(paras)) {
    const t = threads.get(h.key) ?? { id: "t:" + h.key, label: h.label, beats: [] };
    t.beats.push({ kind: h.kind, span: makeSpan(h.p, h.start, h.end) });
    threads.set(h.key, t);
  }
  for (const x of Object.values(ai)) {
    for (const tb of x.threadBeats) {
      if (!liveHashes.has(`${tb.beat.span.sceneId}:${tb.beat.span.paraHash}`)) continue;
      const key = tb.label.toLowerCase();
      const t = threads.get(key) ?? { id: "t:" + fnv1a(key), label: tb.label, beats: [] };
      t.beats.push(tb.beat);
      threads.set(key, t);
    }
  }

  return { entities, facts, mentions, threads: [...threads.values()], themes };
}

function mergeAiEntities(entities: Entity[], ai: AiExtraction[], project: Project): Entity[] {
  const not = new Set(project.bible.notEntities);
  for (const x of ai) {
    for (const ae of x.entities) {
      if (not.has(ae.name)) continue;
      const names = [ae.name, ...ae.aliases];
      const hit = entities.find((e) => names.some((n) => n === e.name || e.aliases.includes(n)));
      if (hit) {
        for (const n of names) if (n !== hit.name && !hit.aliases.includes(n)) hit.aliases.push(n);
      } else {
        entities.push({ id: entityId(ae.name), kind: ae.kind, name: ae.name, aliases: ae.aliases.filter((a) => a !== ae.name) });
      }
    }
  }
  return entities;
}

/** Which scenes each entity appears in, in reading order. */
export function presence(model: StoryModel, scenes: Scene[]) {
  const order = new Map(scenes.map((s, i) => [s.id, i]));
  const out = new Map<string, Set<number>>();
  for (const m of model.mentions) {
    const i = order.get(m.span.sceneId);
    if (i === undefined) continue;
    if (!out.has(m.entityId)) out.set(m.entityId, new Set());
    out.get(m.entityId)!.add(i);
  }
  return out;
}
