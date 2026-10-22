// Rule checks over the local story model. They run on every analysis pass and
// need no network. Each issue cites the passages in conflict and, where it
// can, offers minimal edits the author applies with one click.

import { factKey, orderedScenes, presence } from "./model";
import { fnv1a, formatNumberLike, levenshtein, segment, sentenceSpan, yearOf, type Paragraph } from "./text";
import type { Entity, Fact, Issue, Project, Scene, Span, StoryModel, Suggestion } from "./types";

const ATTR_LABEL: Record<string, string> = { eyes: "eye colour", hair: "hair colour" };

export function runChecks(project: Project, model: StoryModel): Issue[] {
  const scenes = orderedScenes(project);
  const order = new Map(scenes.map((s, i) => [s.id, i]));
  const ent = new Map(model.entities.map((e) => [e.id, e]));
  const paras = new Map<string, Paragraph>();
  for (const s of scenes) for (const p of segment(s)) paras.set(`${s.id}:${p.hash}`, p);
  const widen = (span: Span) => {
    const p = paras.get(`${span.sceneId}:${span.paraHash}`);
    return p ? sentenceSpan(p, span.start, span.end) : span;
  };
  const ctx: Ctx = { project, model, scenes, order, ent, widen };
  const all = [
    ...attributeConflicts(ctx),
    ...ageConflicts(ctx),
    ...deadReturns(ctx),
    ...nameDrift(ctx),
    ...timeline(ctx),
    ...openThreads(ctx),
    ...absences(ctx),
  ];
  const disabled = new Set(project.settings.disabledTypes);
  return all.filter((i) => !disabled.has(i.type));
}

interface Ctx {
  project: Project;
  model: StoryModel;
  scenes: Scene[];
  order: Map<string, number>;
  ent: Map<string, Entity>;
  /** Widen a name or phrase to its sentence, for display. */
  widen: (s: Span) => Span;
}

const chapterOf = (ctx: Ctx, span: Span) => {
  const s = ctx.scenes.find((x) => x.id === span.sceneId);
  return s ? `ch. ${s.chapter}` : "?";
};

const byOrder = (ctx: Ctx) => (a: Fact, b: Fact) =>
  (ctx.order.get(a.span.sceneId) ?? 0) - (ctx.order.get(b.span.sceneId) ?? 0) || a.span.start - b.span.start;

function key(...parts: string[]) {
  return fnv1a(parts.join("|"));
}

/** Same entity, same attribute, different values (green eyes in ch. 2, brown in ch. 19). */
function attributeConflicts(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  const groups = new Map<string, Fact[]>();
  for (const f of ctx.model.facts) {
    if (!ATTR_LABEL[f.attribute]) continue;
    const k = `${f.entityId}|${f.attribute}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const facts of groups.values()) {
    const values = [...new Set(facts.map((f) => f.value))];
    if (values.length < 2) continue;
    facts.sort(byOrder(ctx));
    const e = ctx.ent.get(facts[0].entityId)!;
    const label = ATTR_LABEL[facts[0].attribute];
    const pinned = facts.find((f) => f.status === "pinned");
    const canon = pinned?.value ?? facts[0].value;
    const conflicting = facts.filter((f) => f.value !== canon);
    const first = facts.find((f) => f.value === canon)!;
    const suggestions: Suggestion[] = [];
    for (const v of pinned ? [canon] : values) {
      const edits = facts
        .filter((f) => f.value !== v && f.valueSpan)
        .map((f) => ({ span: f.valueSpan!, replacement: matchCase(v, f.valueSpan!.quote) }));
      if (edits.length) suggestions.push({ label: `Make it ${v} everywhere (${edits.length} edit${edits.length > 1 ? "s" : ""})`, edits });
    }
    out.push({
      key: key("attribute", e.id, facts[0].attribute, values.sort().join(",")),
      type: "attribute",
      severity: "high",
      entityId: e.id,
      title: `${e.name}'s ${label} changes`,
      explanation: pinned
        ? `Your bible pins ${e.name}'s ${label} as ${canon}, but ${conflicting.map((f) => `${chapterOf(ctx, f.span)} says ${f.value}`).join(", ")}.`
        : `${chapterOf(ctx, first.span)} gives ${e.name} ${canon} ${facts[0].attribute}; ${conflicting
            .map((f) => `${chapterOf(ctx, f.span)} says ${f.value}`)
            .join(", ")}. Pin the right one in the bible and the rest will be checked against it.`,
      spans: [first.span, ...conflicting.map((f) => f.span)],
      suggestions,
    });
  }
  return out;
}

/** Stated ages that disagree with a birth year or with each other, given the scenes' in-story dates. */
function ageConflicts(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  const sceneYear = (f: Fact) => yearOf(ctx.scenes.find((s) => s.id === f.span.sceneId)?.date);
  const byEntity = new Map<string, Fact[]>();
  for (const f of ctx.model.facts) {
    if (f.attribute !== "age" && f.attribute !== "born") continue;
    byEntity.set(f.entityId, [...(byEntity.get(f.entityId) ?? []), f]);
  }
  for (const [eid, facts] of byEntity) {
    facts.sort(byOrder(ctx));
    const e = ctx.ent.get(eid)!;
    const born = facts.find((f) => f.attribute === "born" && f.status === "pinned") ?? facts.find((f) => f.attribute === "born");
    const ages = facts.filter((f) => f.attribute === "age" && sceneYear(f) !== null);
    let ref: { year: number; fact: Fact } | undefined = born ? { year: parseInt(born.value, 10), fact: born } : undefined;
    if (!ref && ages.length) {
      const a0 = ages.find((f) => f.status === "pinned") ?? ages[0];
      ref = { year: sceneYear(a0)! - parseInt(a0.value, 10), fact: a0 };
    }
    if (!ref) continue;
    const bad = ages.filter((f) => f !== ref!.fact && Math.abs(sceneYear(f)! - parseInt(f.value, 10) - ref!.year) > 1);
    if (!bad.length) continue;
    const suggestions: Suggestion[] = [];
    const edits = bad
      .filter((f) => f.valueSpan)
      .map((f) => ({ span: f.valueSpan!, replacement: formatNumberLike(sceneYear(f)! - ref!.year, f.valueSpan!.quote) }));
    if (edits.length) suggestions.push({ label: `Correct the age${edits.length > 1 ? "s" : ""} to match`, edits });
    const refText = born
      ? `${e.name} was born in ${ref.year}`
      : `${chapterOf(ctx, ref.fact.span)} makes ${e.name} ${ref.fact.value} in ${sceneYear(ref.fact)} (born about ${ref.year})`;
    out.push({
      key: key("age", eid, bad.map((f) => f.value + "@" + sceneYear(f)).join(",")),
      type: "age",
      severity: "medium",
      entityId: eid,
      title: `${e.name}'s age doesn't add up`,
      explanation: `${refText}, but ${bad
        .map((f) => `${chapterOf(ctx, f.span)} (set in ${sceneYear(f)}) says ${f.value}, which implies about ${sceneYear(f)! - parseInt(f.value, 10)}`)
        .join("; ")}.`,
      spans: [ref.fact.span, ...bad.map((f) => f.span)],
      suggestions,
    });
  }
  return out;
}

/** Someone dies, then acts in a later scene. */
function deadReturns(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  const deaths = ctx.model.facts.filter((f) => f.attribute === "status" && f.value === "dead").sort(byOrder(ctx));
  const done = new Set<string>();
  for (const d of deaths) {
    if (done.has(d.entityId)) continue;
    done.add(d.entityId);
    const dIdx = ctx.order.get(d.span.sceneId)!;
    const later = ctx.model.mentions.filter((m) => m.entityId === d.entityId && m.acting && (ctx.order.get(m.span.sceneId) ?? -1) > dIdx);
    if (!later.length) continue;
    const e = ctx.ent.get(d.entityId)!;
    const scenesHit = [...new Set(later.map((m) => m.span.sceneId))];
    out.push({
      key: key("dead", d.entityId, scenesHit.join(",")),
      type: "dead-returns",
      severity: "high",
      entityId: d.entityId,
      title: `${e.name} acts after dying`,
      explanation: `${e.name} dies in ${chapterOf(ctx, d.span)}, but acts in ${scenesHit
        .map((id) => `ch. ${ctx.scenes.find((s) => s.id === id)?.chapter}`)
        .join(", ")}. If this is a flashback, a ghost or a mistaken death, mark it intentional.`,
      spans: [d.span, ...scenesHit.map((id) => ctx.widen(later.find((m) => m.span.sceneId === id)!.span))],
      suggestions: [],
    });
  }
  return out;
}

/** "Marcus" and "Markus": two names one or two letters apart. */
function nameDrift(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  const people = ctx.model.entities.filter((e) => e.kind === "character");
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i];
      const b = people[j];
      for (const na of [a.name, ...a.aliases]) {
        const nb = [b.name, ...b.aliases].find((n) => n.length >= 4 && na.length >= 4 && n[0] === na[0] && levenshtein(n, na) <= (n.length >= 7 ? 2 : 1));
        if (!nb) continue;
        const ca = ctx.model.mentions.filter((m) => m.entityId === a.id).length;
        const cb = ctx.model.mentions.filter((m) => m.entityId === b.id).length;
        const [keep, drop] = ca >= cb ? [na, nb] : [nb, na];
        const dropMentions = ctx.model.mentions.filter((m) => m.span.quote === drop);
        const keepMentions = ctx.model.mentions.filter((m) => m.span.quote === keep);
        if (!dropMentions.length || !keepMentions.length) continue;
        out.push({
          key: key("drift", [na, nb].sort().join("~")),
          type: "name-drift",
          severity: "medium",
          entityId: (ctx.model.mentions.find((m) => m.span.quote === keep) ?? { entityId: a.id }).entityId,
          title: `"${drop}" or "${keep}"?`,
          explanation: `${keep} is named ${Math.max(ca, cb)} times; "${drop}" appears ${dropMentions.length === 1 ? "once" : `${dropMentions.length} times`}. If they're the same person, use one spelling. If they're different people, mark this intentional.`,
          spans: dropMentions.slice(0, 3).map((m) => ctx.widen(m.span)),
          context: [ctx.widen(keepMentions[0].span)],
          suggestions: [
            {
              label: `Change "${drop}" to "${keep}" (${dropMentions.length} edit${dropMentions.length > 1 ? "s" : ""})`,
              edits: dropMentions.map((m) => ({ span: m.span, replacement: keep })),
            },
          ],
        });
        break;
      }
    }
  }
  return out;
}

/** One character in two places on the same in-story day. */
function timeline(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  // Who acts in each scene, with the first passage where they do.
  const actors = new Map<string, Map<string, Span>>();
  for (const m of ctx.model.mentions) {
    if (!m.acting) continue;
    const a = actors.get(m.span.sceneId) ?? new Map<string, Span>();
    if (!a.has(m.entityId)) a.set(m.entityId, m.span);
    actors.set(m.span.sceneId, a);
  }
  // date -> entity -> location -> first scene there
  const days = new Map<string, Map<string, Map<string, Scene>>>();
  for (const s of ctx.scenes) {
    if (!s.date || !/^\d{4}-\d{2}-\d{2}/.test(s.date) || !s.location) continue;
    const day = s.date.slice(0, 10);
    const byEntity = days.get(day) ?? new Map<string, Map<string, Scene>>();
    for (const id of actors.get(s.id)?.keys() ?? []) {
      const locs = byEntity.get(id) ?? new Map<string, Scene>();
      if (!locs.has(norm(s.location))) locs.set(norm(s.location), s);
      byEntity.set(id, locs);
    }
    days.set(day, byEntity);
  }
  for (const [day, byEntity] of days) {
    for (const [id, locs] of byEntity) {
      if (locs.size < 2) continue;
      const [a, b] = [...locs.values()];
      const e = ctx.ent.get(id)!;
      const next = nextDay(day);
      out.push({
        key: key("timeline", id, a.id, b.id, day),
        type: "timeline",
        severity: "high",
        entityId: id,
        title: `${e.name} is in two places on ${day}`,
        explanation: `Ch. ${a.chapter} puts ${e.name} in ${a.location} and ch. ${b.chapter} puts them in ${b.location}, both on ${day}. Change a scene's date or location, or mark this intentional if the travel is possible.`,
        spans: [ctx.widen(actors.get(a.id)!.get(id)!), ctx.widen(actors.get(b.id)!.get(id)!)],
        suggestions: [{ label: `Move ch. ${b.chapter} "${b.title}" to ${next}`, edits: [], meta: { sceneId: b.id, field: "date", value: next } }],
      });
    }
  }
  return out;
}

/** Threads opened and never resolved. */
function openThreads(ctx: Ctx): Issue[] {
  return ctx.model.threads
    .filter((t) => !t.beats.some((b) => b.kind === "resolve"))
    .map((t) => {
      const opened = t.beats.find((b) => b.kind === "open") ?? t.beats[0];
      const last = t.beats[t.beats.length - 1];
      return {
        key: key("thread", t.id),
        type: "open-thread" as const,
        severity: "medium" as const,
        title: `Open thread: ${t.label.toLowerCase()}`,
        explanation: `Opened in ${chapterOf(ctx, opened.span)}${
          t.beats.length > 1 ? `, last touched in ${chapterOf(ctx, last.span)}` : ""
        }, and never resolved. Pay it off, or mark it intentional if it carries into the next book.`,
        spans: [ctx.widen(opened.span)],
        context: t.beats.length > 1 ? [ctx.widen(last.span)] : [],
        suggestions: [],
      };
    });
}

/** A recurring character missing for a long stretch. */
function absences(ctx: Ctx): Issue[] {
  const out: Issue[] = [];
  const n = ctx.scenes.length;
  if (n < 5) return out;
  const pres = presence(ctx.model, ctx.scenes);
  for (const [id, set] of pres) {
    const e = ctx.ent.get(id);
    if (!e || e.kind !== "character" || set.size < 3) continue;
    const idxs = [...set].sort((a, b) => a - b);
    let best = { from: -1, to: -1, len: 0 };
    for (let k = 0; k < idxs.length - 1; k++) {
      const len = idxs[k + 1] - idxs[k] - 1;
      if (len > best.len) best = { from: idxs[k], to: idxs[k + 1], len };
    }
    const tail = n - 1 - idxs[idxs.length - 1];
    if (tail > best.len) best = { from: idxs[idxs.length - 1], to: -1, len: tail };
    if (best.len < 3 || best.len / n < ctx.project.settings.absenceShare) continue;
    const lastSeen = ctx.model.mentions.filter((m) => m.entityId === id && ctx.order.get(m.span.sceneId) === best.from).pop()!;
    const back = best.to >= 0 ? ctx.model.mentions.find((m) => m.entityId === id && ctx.order.get(m.span.sceneId) === best.to) : undefined;
    out.push({
      key: key("absence", id, String(best.from), String(best.to)),
      type: "absence",
      severity: "low",
      entityId: id,
      title: `${e.name} disappears for ${best.len} scenes`,
      explanation: back
        ? `${e.name} appears in ${set.size} scenes but is absent from ch. ${ctx.scenes[best.from + 1].chapter} to ch. ${ctx.scenes[best.to - 1].chapter} (${Math.round((100 * best.len) / n)}% of the book).`
        : `${e.name} appears in ${set.size} scenes, then is not seen again after ch. ${ctx.scenes[best.from].chapter} (${Math.round((100 * best.len) / n)}% of the book).`,
      spans: [],
      context: back ? [ctx.widen(lastSeen.span), ctx.widen(back.span)] : [ctx.widen(lastSeen.span)],
      suggestions: [],
    });
  }
  return out;
}

function norm(s: string) {
  return s.toLowerCase().replace(/^the\s+/, "").trim();
}

function nextDay(d: string) {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function matchCase(v: string, like: string) {
  return /^[A-Z]/.test(like) ? v[0].toUpperCase() + v.slice(1) : v;
}

export { factKey };
