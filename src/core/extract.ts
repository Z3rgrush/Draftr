// Local extraction: a fast, offline, rule-based reader. It finds names, who is
// acting in a passage, and a handful of high-value facts (eyes, hair, age,
// birth year, death). The AI tier (Chaptr) adds what rules can't see; both feed
// the same story model.

import type { BibleEdits, Entity, EntityKind, Mention, RawFact } from "./types";
import { escapeRe, makeSpan, NUMBER_WORDS, parseNumber, sentences, type Paragraph } from "./text";

const STOP = new Set(
  `A An The And But Or Nor So Yet For If When While Then Than That This These Those There Here Where Why How What Who Whom Whose Which
  I I'd I'm I've I'll Me My Mine We Us Our You Your He Him His She Her Hers It Its They Them Their Not No Yes Oh Ah Well Now Just Still
  Even Only Again Once After Before Because Since Until Unless Though Although As At By In On Of To From Into Onto With Without Within
  Over Under Above Below Behind Beyond Through Across Along Around About Against Between Among Up Down Out Off Some Any All Each Every
  Both Either Neither Most Many Much More Less Few Several Such Nothing Something Anything Everything Nobody Somebody Anybody Everybody
  Someone Anyone Everyone None One Two Three Four Five Six Seven Eight Nine Ten First Second Last Next Another Other Others
  Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November
  December Chapter Part Book Scene Prologue Epilogue God Lord Sir Madam Mum Mom Dad Mother Father Did Do Does Was Were Is Are Be Been
  Had Has Have Could Would Should Will Can Must Might Shall Let Don't Didn't Wasn't Couldn't Wouldn't It's That's There's Perhaps Maybe
  Later Soon Then Never Always Sometimes Today Tonight Tomorrow Yesterday Morning Evening Night Afternoon Inside Outside Above Somewhere
  Hello Goodbye Thanks Please Sorry Yes Okay OK Mr Mrs Ms Dr Miss`.split(/\s+/),
);

const TITLES = new Set(
  "Mr Mrs Ms Miss Dr Captain Detective Inspector Sergeant Constable Professor Aunt Uncle Lady Lord Sir Father Sister Brother Judge Mayor Colonel Major Lieutenant".split(
    " ",
  ),
);

const NICKNAMES: Record<string, string[]> = {
  Elizabeth: ["Liz", "Lizzie", "Beth", "Eliza", "Betty"],
  Thomas: ["Tom", "Tommy"],
  William: ["Will", "Bill", "Billy"],
  Robert: ["Rob", "Bob", "Bobby"],
  Margaret: ["Maggie", "Meg", "Peggy"],
  Katherine: ["Kate", "Kat", "Katie"],
  Catherine: ["Cate", "Cat", "Cathy"],
  Jonathan: ["Jon", "Jonny"],
  Alexander: ["Alex", "Sasha"],
  Alexandra: ["Alex", "Lexi"],
  Benjamin: ["Ben", "Benny"],
  Samuel: ["Sam"],
  Samantha: ["Sam"],
  Daniel: ["Dan", "Danny"],
  Michael: ["Mike", "Mick"],
  Rebecca: ["Becky", "Becca"],
  Edward: ["Ed", "Eddie", "Ned"],
  Josephine: ["Jo", "Josie"],
  Victoria: ["Vic", "Tori"],
  Nicholas: ["Nick", "Nicky"],
};

const PLACE_SUFFIX =
  /\b(Street|Road|Lane|Avenue|House|Hall|Manor|Bay|Harbour|Harbor|Station|Docks|Square|Park|Bridge|Church|Abbey|Castle|Hill|Wood|Woods|River|Lake|Island|City|Town|Village|Market|Quay|Hotel|Inn|Gardens|Street)$/;
const PLACE_PREP = /\b(in|to|from|at|toward|towards|into|near|through|across|reached|left|outside|beyond|around)\s+(?:the\s+)?$/i;

const ACT_AFTER =
  /^(?:\s+(?:\w+ly\s+)?(?:said|says|asked|asks|replied|whispered|shouted|muttered|called|laughed|smiled|nodded|shrugged|sighed|walked|ran|turned|looked|stood|sat|took|opened|closed|came|went|left|arrived|answered|told|reached|pulled|pushed|poured|watched|waited|lit|grabbed|shook|leaned|knelt|stepped|crossed|picked|set|handed|wrote|read|spoke|kept|kissed|held|frowned|paused|began|tried|wanted|knew|thought|felt|saw|heard|lifted|dropped|climbed|drove|rode|signed|struck|laid|lay|slept|woke|ate|drank|hesitated|glanced|followed)\b|'s voice|’s voice)/;
const ACT_BEFORE = /[,!?…—]["”’]?\s*(?:said|asked|replied|whispered|shouted|muttered|called|answered)\s+$/;

export function isTitle(word: string) {
  return TITLES.has(word);
}

interface Candidate {
  name: string;
  total: number;
  nonInitial: number;
  placeVotes: number;
  actVotes: number;
  title?: string;
}

const CAP_RE = /\b[A-Z][a-zA-Z'’-]*(?:\s+[A-Z][a-zA-Z'’-]*)*/g;

function stripPossessive(w: string) {
  return w.replace(/(?:'s|’s|'|’)$/, "");
}

/** Find the named entities of the whole manuscript. */
export function discoverEntities(paragraphs: Paragraph[], bible: BibleEdits): Entity[] {
  const cands = new Map<string, Candidate>();
  for (const p of paragraphs) {
    const text = p.text;
    let m: RegExpExecArray | null;
    CAP_RE.lastIndex = 0;
    while ((m = CAP_RE.exec(text))) {
      let words = m[0].split(/\s+/).map(stripPossessive);
      let offset = m.index;
      let initial = isSentenceInitial(text, m.index);
      // Drop leading stopwords ("When Hale" -> "Hale"); what is left is no longer sentence-initial.
      while (words.length && STOP.has(words[0])) {
        offset += text.slice(offset).indexOf(words[0]) + words[0].length;
        words = words.slice(1);
        initial = false;
      }
      while (words.length && STOP.has(words[words.length - 1])) words = words.slice(0, -1);
      if (!words.length) continue;
      let title: string | undefined;
      while (words.length && TITLES.has(words[0])) {
        title = words[0];
        words = words.slice(1);
        initial = false;
      }
      if (!words.length) continue;
      const name = words.join(" ");
      if (name.length < 2 || /^[A-Z]+$/.test(name) && name.length < 3) continue;
      const c = cands.get(name) ?? { name, total: 0, nonInitial: 0, placeVotes: 0, actVotes: 0 };
      c.total++;
      if (!initial) c.nonInitial++;
      if (title) c.title = title;
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (PLACE_PREP.test(before)) c.placeVotes++;
      if (ACT_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40)) || ACT_BEFORE.test(before)) c.actVotes++;
      cands.set(name, c);
    }
  }

  // Two capitalised words in a row ("Markus Ortiz") are a name even at the start of a sentence.
  const accepted = [...cands.values()].filter((c) => c.nonInitial >= 1 || c.total >= 3 || c.name.includes(" "));
  const multi = accepted.filter((c) => c.name.includes(" "));
  const single = accepted.filter((c) => !c.name.includes(" "));

  const entities = new Map<string, Entity>();
  const kindOf = (c: Candidate): EntityKind =>
    PLACE_SUFFIX.test(c.name) || (c.placeVotes > c.actVotes && c.placeVotes >= Math.max(1, c.total / 3) && !c.title)
      ? "place"
      : "character";

  for (const c of multi) {
    entities.set(c.name, {
      id: entityId(c.name),
      kind: kindOf(c),
      name: c.name,
      aliases: c.title ? [`${c.title} ${c.name.split(" ").pop()}`] : [],
    });
  }
  const byFreq = [...multi].sort((a, b) => b.total - a.total);
  for (const c of single) {
    const owner =
      byFreq.find((mc) => mc.name.split(" ").includes(c.name)) ??
      byFreq.find((mc) => (NICKNAMES[mc.name.split(" ")[0]] ?? []).includes(c.name));
    if (owner) {
      const e = entities.get(owner.name)!;
      if (!e.aliases.includes(c.name)) e.aliases.push(c.name);
      if (c.title && !e.aliases.includes(`${c.title} ${c.name}`)) e.aliases.push(`${c.title} ${c.name}`);
      continue;
    }
    entities.set(c.name, {
      id: entityId(c.name),
      kind: kindOf(c),
      name: c.name,
      aliases: c.title ? [`${c.title} ${c.name}`] : [],
    });
  }
  return applyBible([...entities.values()], bible);
}

/** The author's bible edits always win over discovery. */
export function applyBible(list: Entity[], bible: BibleEdits): Entity[] {
  const not = new Set(bible.notEntities);
  let out = list.filter((e) => !not.has(e.name));
  for (const [alias, canonical] of Object.entries(bible.merges)) {
    const target = out.find((e) => e.name === canonical || e.aliases.includes(canonical));
    const source = out.find((e) => e.name === alias);
    if (!target || target === source) continue;
    if (source) {
      out = out.filter((e) => e !== source);
      for (const a of [source.name, ...source.aliases]) if (!target.aliases.includes(a)) target.aliases.push(a);
    } else {
      for (const e of out) e.aliases = e.aliases.filter((a) => a !== alias);
      if (!target.aliases.includes(alias)) target.aliases.push(alias);
    }
  }
  for (const e of out) {
    const renamed = bible.renames[e.id];
    if (renamed && renamed !== e.name) {
      if (!e.aliases.includes(e.name)) e.aliases.push(e.name);
      e.name = renamed;
      e.aliases = e.aliases.filter((a) => a !== renamed);
    }
    if (bible.kinds[e.id]) e.kind = bible.kinds[e.id];
  }
  return out;
}

export function entityId(name: string) {
  return "e:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isSentenceInitial(text: string, idx: number) {
  const before = text.slice(0, idx);
  return /(^|[.!?…:]["”’']?\s+|["“‘(—]\s*)$/.test(before);
}

export type Gender = "f" | "m";

export interface NameIndex {
  entities: Entity[];
  byId: Map<string, Entity>;
  byAlias: Map<string, Entity>;
  re: RegExp;
  gender: Map<string, Gender>;
  /** Alternation of character names and aliases, longest first, for fact patterns. */
  characterAlt: string;
}

const rxCache = new Map<string, RegExp>();
/** Compile once, reuse across paragraphs. Returned regexes are global, so reset lastIndex. */
function rx(src: string, flags: string) {
  const k = flags + src;
  let r = rxCache.get(k);
  if (!r) {
    if (rxCache.size > 500) rxCache.clear();
    r = new RegExp(src, flags);
    rxCache.set(k, r);
  }
  r.lastIndex = 0;
  return r;
}

export function buildNameIndex(entities: Entity[]): NameIndex {
  const byAlias = new Map<string, Entity>();
  for (const e of entities) for (const n of [e.name, ...e.aliases]) byAlias.set(n, e);
  const names = [...byAlias.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = names.length ? new RegExp(`\\b(${names.join("|")})(?:'s|’s)?(?![\\w])`, "g") : /$^/g;
  const characterAlt = [...byAlias.keys()]
    .filter((n) => byAlias.get(n)!.kind === "character")
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
  return { entities, byId: new Map(entities.map((e) => [e.id, e])), byAlias, re, gender: new Map(), characterAlt };
}

export interface FoundMention extends Mention {
  name: string;
}

export function findMentions(p: Paragraph, idx: NameIndex): FoundMention[] {
  const out: FoundMention[] = [];
  idx.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = idx.re.exec(p.text))) {
    const e = idx.byAlias.get(m[1])!;
    const end = m.index + m[1].length;
    const before = p.text.slice(Math.max(0, m.index - 20), m.index);
    const acting =
      e.kind === "character" && (ACT_AFTER.test(p.text.slice(m.index + m[0].length, m.index + m[0].length + 40)) || ACT_BEFORE.test(before));
    out.push({ entityId: e.id, name: m[1], span: makeSpan(p, m.index, end), acting });
  }
  return out;
}

/** Vote each character's pronouns from the sentences where they lead. */
export function inferGenders(paragraphs: Paragraph[], idx: NameIndex) {
  const votes = new Map<string, { f: number; m: number }>();
  for (const p of paragraphs) {
    const ms = findMentions(p, idx);
    const ss = sentences(p.text);
    for (const [si, s] of ss.entries()) {
      const first = ms.find((x) => x.span.start >= s.start && x.span.start < s.end);
      if (!first || idx.byId.get(first.entityId)?.kind !== "character") continue;
      const others = ms.filter((x) => x.span.start > first.span.start && x.span.start < s.end && x.entityId !== first.entityId);
      if (others.length) continue;
      const v = votes.get(first.entityId) ?? { f: 0, m: 0 };
      // "Hale turned. She ..." is the strongest signal; "her own" next; any other pronoun in the sentence is weak.
      const nx = ss[si + 1];
      const lead = nx?.text.trimStart().match(/^["“]?(She|He)\b/);
      if (lead && !ms.some((x) => x.span.start >= nx.start && x.span.start < nx.end)) {
        if (lead[1] === "She") v.f += 3;
        else v.m += 3;
      }
      const rest = p.text.slice(first.span.end, s.end);
      const pm = rest.match(/\b(she|her|hers|herself|he|him|his|himself)\b(\s+own\b)?/i);
      if (pm) {
        const w = pm[2] || /self$/i.test(pm[1]) ? 2 : 1;
        if (/^(she|her|hers|herself)$/i.test(pm[1])) v.f += w;
        else v.m += w;
      }
      votes.set(first.entityId, v);
    }
  }
  for (const [id, v] of votes) if (v.f !== v.m) idx.gender.set(id, v.f > v.m ? "f" : "m");
}

const EYE = "green|brown|blue|grey|gray|hazel|black|amber|violet|dark|pale|silver|golden";
const HAIR = "red|black|blonde|blond|brown|grey|gray|white|auburn|dark|silver|copper|fair|ginger|chestnut";
const PRON_F = /^(she|her)$/i;

/** Context carried between paragraphs so "she" at the top of a paragraph resolves. */
export interface Carry {
  lastF?: string;
  lastM?: string;
  last?: string;
}

/** Extract facts from one paragraph. Mentions must be this paragraph's, in order. */
export function extractFacts(p: Paragraph, idx: NameIndex, mentions: FoundMention[], carry: Carry): RawFact[] {
  const facts: RawFact[] = [];
  const t = p.text;
  const A = idx.characterAlt;
  if (!A) return facts;
  const SUBJ = `(${A}|she|he|her|his|She|He|Her|His)`;
  const POSS = `(?:${SUBJ}(?:'s|’s)?)`;

  const resolve = (word: string, pos: number): string | undefined => {
    const direct = idx.byAlias.get(word.replace(/(?:'s|’s)$/, ""));
    if (direct) return direct.id;
    const want: Gender = PRON_F.test(word) ? "f" : "m";
    for (let i = mentions.length - 1; i >= 0; i--) {
      const mm = mentions[i];
      if (mm.span.start >= pos) continue;
      const g = idx.gender.get(mm.entityId);
      const e = idx.byId.get(mm.entityId);
      if (e?.kind !== "character") continue;
      if (g === want || g === undefined) return mm.entityId;
    }
    return want === "f" ? carry.lastF : carry.lastM;
  };

  const add = (m: RegExpExecArray, ownerWord: string, ownerPos: number, attribute: string, value: string, valueText: string, conf: number) => {
    const owner = resolve(ownerWord, ownerPos);
    if (!owner) return;
    const e = idx.byId.get(owner)!;
    const vStart = m.index + m[0].lastIndexOf(valueText);
    facts.push({
      entityName: e.name,
      attribute,
      value,
      span: wideSpan(p, m.index, m.index + m[0].length),
      valueSpan: makeSpan(p, vStart, vStart + valueText.length),
      confidence: idx.byAlias.has(ownerWord.replace(/(?:'s|’s)$/, "")) ? conf : conf - 0.15,
      source: "local",
    });
  };

  const run = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) fn(m);
  };

  // Eyes: "her green eyes", "Hale's eyes were brown", "Hale had green eyes"
  for (const [attr, colours, noun] of [
    ["eyes", EYE, "eyes"],
    ["hair", HAIR, "hair"],
  ] as const) {
    if (!t.includes(noun)) continue;
    run(rx(`\\b${POSS}\\s+(?:[a-z]+\\s+){0,1}?(${colours})(?:-flecked|ish)?\\s+${noun}\\b`, "g"), (m) =>
      add(m, m[1], m.index, attr, norm(m[2]), m[2], 0.9),
    );
    run(rx(`\\b${POSS}\\s+${noun}\\s+(?:were|was|are|is|had been|looked|gleamed|shone|flashed|burned)\\s+(?:[a-z]+\\s+)?(${colours})\\b`, "g"), (m) =>
      add(m, m[1], m.index, attr, norm(m[2]), m[2], 0.9),
    );
    run(rx(`\\b${SUBJ}\\s+(?:had|has)\\s+(?:[a-z]+\\s+){0,1}?(${colours})\\s+${noun}\\b`, "g"), (m) =>
      add(m, m[1], m.index, attr, norm(m[2]), m[2], 0.9),
    );
  }

  // Age: "Hale was thirty-four years old", "she had just turned 34.", "the thirty-four-year-old Hale"
  if (/years old|year-old|\b(?:turned|was|is|be) [a-z0-9-]+[.,;!?]/i.test(t)) {
    run(rx(`\\b${SUBJ}\\s+(?:was|is|had just turned|turned|was now|would be)\\s+(${NUMBER_WORDS})(?=\\s+years\\s+old|[.,;!?]|\\s+(?:that|this|last|next)\\s+(?:spring|summer|autumn|winter|year))`, "gi"),
      (m) => {
        const n = parseNumber(m[2]);
        if (n !== null && n > 0 && n < 120) add(m, m[1], m.index, "age", String(n), m[2], 0.85);
      },
    );
    run(rx(`\\b(${NUMBER_WORDS})-year-old\\s+(?:[a-z]+\\s+)?(${A})\\b`, "gi"), (m) => {
      const n = parseNumber(m[1]);
      if (n !== null) add(m, m[2], m.index, "age", String(n), m[1], 0.85);
    });
  }

  // Birth year: "Hale was born in 1960", "born in March 1960"
  if (t.includes("born"))
    run(rx(`\\b${SUBJ}\\s+(?:was|had been)\\s+born\\s+(?:in\\s+)?(?:[A-Z][a-z]+\\s+)?(?:of\\s+)?(\\d{4})\\b`, "g"), (m) =>
      add(m, m[1], m.index, "born", m[2], m[2], 0.9),
    );

  // Death: "Reed died", "Reed's body", "the death of Reed", "killed Reed"
  if (!/\b(?:died|dead|killed|murdered|drowned|shot|buried|body|corpse|funeral|coffin|death)\b/.test(t)) return finish();
  const negate = /\b(if|nearly|almost|not|never|could have|might have|would have|thought)\s+(?:\w+\s+)?$/i;
  run(rx(`\\b(${A})\\s+(?:had\\s+)?(?:died|was dead|was killed|was murdered|lay dead|is dead|had been killed|had been murdered|drowned)\\b`, "g"), (m) => {
    if (!negate.test(t.slice(Math.max(0, m.index - 30), m.index))) add(m, m[1], m.index, "status", "dead", m[1], 0.85);
  });
  run(rx(`\\b(?:killed|murdered|shot|buried)\\s+(${A})\\b`, "g"), (m) => {
    if (!negate.test(t.slice(Math.max(0, m.index - 30), m.index))) add(m, m[1], m.index, "status", "dead", m[1], 0.8);
  });
  run(rx(`\\b(${A})(?:'s|’s)\\s+(?:body|corpse|funeral|coffin)\\b|\\bdeath of (${A})\\b`, "g"), (m) =>
    add(m, m[1] ?? m[2], m.index, "status", "dead", m[1] ?? m[2], 0.75),
  );

  return finish();

  function finish() {
    // Update carry with the last named characters in this paragraph.
    for (const mm of mentions) {
      const e = idx.byId.get(mm.entityId);
      if (e?.kind !== "character") continue;
      carry.last = mm.entityId;
      const g = idx.gender.get(mm.entityId);
      if (g === "f") carry.lastF = mm.entityId;
      if (g === "m") carry.lastM = mm.entityId;
    }
    return dedupe(facts);
  }
}

function norm(v: string) {
  const s = v.toLowerCase();
  if (s === "gray") return "grey";
  if (s === "blond") return "blonde";
  return s;
}

function wideSpan(p: Paragraph, start: number, end: number) {
  const s = sentences(p.text).find((x) => x.start <= start && x.end >= start);
  if (!s) return makeSpan(p, start, end);
  const lead = s.text.length - s.text.trimStart().length;
  return makeSpan(p, s.start + lead, Math.max(end, s.start + s.text.trimEnd().length));
}

function dedupe(facts: RawFact[]) {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = `${f.entityName}|${f.attribute}|${f.value}|${f.valueSpan?.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- Plot threads: an object introduced as a mystery, then seen again until it is resolved.

const THREAD_OPEN = /\b(?:the|an?)\s+(unsigned|anonymous|missing|locked|unopened|sealed|stolen|hidden|mysterious|strange|secret|unexplained)\s+([a-z]+)\b/gi;
const THREAD_RESOLVE =
  /\b(opened|unlocked|unsealed|revealed|discovered|decoded|confessed|explained|solved|recovered|identified|traced|who (?:had )?(?:sent|written|wrote|taken|stolen)|finally (?:found|understood|knew))\b/i;

export interface ThreadHit {
  key: string;
  label: string;
  kind: "open" | "advance" | "resolve";
  p: Paragraph;
  start: number;
  end: number;
}

export function findThreads(ordered: Paragraph[]): ThreadHit[] {
  const hits: ThreadHit[] = [];
  const open = new Map<string, string>();
  for (const p of ordered) {
    const openedHere = new Set<string>();
    let m: RegExpExecArray | null;
    THREAD_OPEN.lastIndex = 0;
    while ((m = THREAD_OPEN.exec(p.text))) {
      const key = singular(m[2].toLowerCase());
      if (open.has(key) || ["one", "way", "thing", "man", "woman", "voice", "look", "feeling", "sense", "smile"].includes(key)) continue;
      const label = `The ${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
      open.set(key, label);
      openedHere.add(key);
      hits.push({ key, label, kind: "open", p, start: m.index, end: m.index + m[0].length });
    }
    for (const [key, label] of open) {
      if (openedHere.has(key)) continue;
      const re = new RegExp(`\\b(?:the|that|this)\\s+(?:[a-z]+\\s+)?${escapeRe(key)}s?\\b`, "i");
      for (const s of sentences(p.text)) {
        const mm = re.exec(s.text);
        if (!mm) continue;
        const kind = THREAD_RESOLVE.test(s.text) ? "resolve" : "advance";
        hits.push({ key, label, kind, p, start: s.start + mm.index, end: s.start + mm.index + mm[0].length });
      }
    }
  }
  return hits;
}

function singular(w: string) {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

// --- Themes and motifs: a lexicon per theme, counted per scene.

export const DEFAULT_THEMES: Record<string, string[]> = {
  Fire: ["fire", "fires", "flame", "flames", "smoke", "ash", "ashes", "burn", "burned", "burning", "burnt", "ember", "embers", "blaze", "scorched"],
  "The sea": ["sea", "tide", "tides", "harbour", "harbor", "waves", "salt", "gulls", "shore", "boat", "boats", "quay"],
  Grief: ["grief", "grieve", "grieving", "mourn", "mourning", "funeral", "loss", "grave", "widow", "tears", "wept", "buried"],
  Secrets: ["secret", "secrets", "lie", "lies", "lied", "hidden", "hide", "concealed", "whispered", "informant", "betrayed", "betrayal"],
  Letters: ["letter", "letters", "ink", "envelope", "handwriting", "wrote", "written", "postmark", "signature"],
  Memory: ["remember", "remembered", "memory", "memories", "forgot", "forgotten", "photograph", "past"],
};

export function countThemes(p: Paragraph, lexicon: Record<string, string[]>): Record<string, number> {
  const words = p.text.toLowerCase().match(/[a-z']+/g) ?? [];
  const out: Record<string, number> = {};
  for (const [theme, list] of Object.entries(lexicon)) {
    const set = new Set(list.map((w) => w.toLowerCase()));
    const n = words.filter((w) => set.has(w)).length;
    if (n) out[theme] = n;
  }
  return out;
}
