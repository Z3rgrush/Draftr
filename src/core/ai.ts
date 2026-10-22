// The AI tier. The app talks to it through one narrow interface shaped like the
// API proposed for Chaptr (POST /extract, POST /check), so the editor and story
// model never depend on a particular model or vendor. Until Chaptr's endpoints
// exist, ClaudeStandIn implements the same interface on the Claude API.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { segment, sentenceSpan, type Paragraph } from "./text";
import type { AiExtraction, Entity, Fact, Issue, Scene, Span } from "./types";

export interface SendLogEntry {
  at: string;
  endpoint: "extract" | "check";
  scene: string;
  chars: number;
  ok: boolean;
  note?: string;
}

export interface StoryAI {
  readonly name: string;
  extract(scene: Scene, known: Entity[]): Promise<AiExtraction>;
  check(scene: Scene, context: { facts: Fact[]; entities: Entity[]; sceneTitles: Map<string, string> }): Promise<Issue[]>;
}

const ExtractSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["character", "place", "object", "theme"]),
      aliases: z.array(z.string()),
    }),
  ),
  facts: z.array(
    z.object({
      entity: z.string(),
      attribute: z.string(),
      value: z.string(),
      quote: z.string(),
      value_text: z.string(),
    }),
  ),
  thread_beats: z.array(
    z.object({
      thread: z.string(),
      kind: z.enum(["open", "advance", "resolve"]),
      quote: z.string(),
    }),
  ),
});

const CheckSchema = z.object({
  issues: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      quotes: z.array(z.string()),
      fix_quote: z.string(),
      fix_replacement: z.string(),
    }),
  ),
});

const EXTRACT_SYSTEM = `You read one scene of a novel in progress and record continuity facts for the author's story bible.
You never rewrite or judge the prose.
- entities: named characters, places and significant objects in this scene, with any aliases used for them. Use the canonical names from the known-entities list when they match.
- facts: stable attributes worth keeping consistent across a book: physical traits (eyes, hair, height, scars), age, birth year, relationships (attribute "relationship:<other name>"), occupation, status (alive/dead/missing), where they live, what they know (attribute "knows", value = the secret). Lower-case single-word values where possible ("green", "dead", "34").
- quote: copy the exact words from the scene that support the fact, verbatim, one sentence or less. value_text: the exact words inside quote that state the value, or "" if none.
- thread_beats: plot questions the scene opens ("who sent the letter?"), advances, or resolves. Use a short stable label for the thread.
Only record what the text states. Skip anything you would have to guess.`;

const CHECK_SYSTEM = `You are a continuity editor reading one scene of a novel against the facts already established in the author's story bible.
Report only real contradictions: a character knowing something before they could have learned it, a point-of-view slip, a setting detail that changed, a relationship or occupation that changed, a timeline impossibility. Do not report style, pacing, or anything the author may have done on purpose without a contradiction.
For each issue, quote the exact words from the scene (and from the bible quotes if relevant) in quotes. If a minimal edit would fix it, give fix_quote (exact words from the scene) and fix_replacement; otherwise leave both empty.
Return an empty list when the scene is consistent. Precision matters more than coverage.`;

export class ClaudeStandIn implements StoryAI {
  readonly name = "Claude (stand-in for Chaptr)";
  private client: Anthropic;
  constructor(
    apiKey: string,
    private log: (e: SendLogEntry) => void,
    private model = "claude-opus-5-5",
  ) {
    // The prototype calls the API from the desktop webview with the author's own key.
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async extract(scene: Scene, known: Entity[]): Promise<AiExtraction> {
    const paras = segment(scene);
    const knownList = known.map((e) => `${e.name} (${e.kind}${e.aliases.length ? `; also ${e.aliases.join(", ")}` : ""})`).join("\n");
    const user = `Known entities:\n${knownList || "(none yet)"}\n\nScene "${scene.title}" (chapter ${scene.chapter}${scene.date ? `, set ${scene.date}` : ""}${scene.location ? `, in ${scene.location}` : ""}):\n\n${scene.text}`;
    const entry: SendLogEntry = { at: new Date().toISOString(), endpoint: "extract", scene: scene.title, chars: user.length, ok: false };
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(ExtractSchema) },
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content: user }],
      });
      if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no result (${res.stop_reason})`);
      const out = res.parsed_output;
      entry.ok = true;
      const facts = out.facts.flatMap((f) => {
        const span = find(paras, f.quote);
        if (!span) return [];
        const v = f.value_text ? span.quote.indexOf(f.value_text) : -1;
        const valueSpan = v >= 0 ? { ...span, start: span.start + v, end: span.start + v + f.value_text.length, quote: f.value_text } : undefined;
        return [{ entityName: f.entity, attribute: f.attribute.toLowerCase(), value: f.value.toLowerCase(), span, valueSpan, confidence: 0.8, source: "ai" as const }];
      });
      const threadBeats = out.thread_beats.flatMap((b) => {
        const span = find(paras, b.quote);
        return span ? [{ label: b.thread, beat: { kind: b.kind, span } }] : [];
      });
      return { sceneId: scene.id, paraHashes: paras.map((p) => p.hash), entities: out.entities, facts, threadBeats };
    } catch (err) {
      entry.note = describe(err);
      throw err;
    } finally {
      this.log(entry);
    }
  }

  async check(scene: Scene, ctx: { facts: Fact[]; entities: Entity[]; sceneTitles: Map<string, string> }): Promise<Issue[]> {
    const paras = segment(scene);
    const names = new Map(ctx.entities.map((e) => [e.id, e.name]));
    const bible = ctx.facts
      .filter((f) => f.span.sceneId !== scene.id)
      .map((f) => `${names.get(f.entityId)} · ${f.attribute} · ${f.value} (${ctx.sceneTitles.get(f.span.sceneId)}: "${f.span.quote}")`)
      .join("\n");
    const user = `Story bible facts from other scenes:\n${bible || "(none)"}\n\nScene "${scene.title}" (chapter ${scene.chapter}${scene.pov ? `, POV ${scene.pov}` : ""}${scene.date ? `, set ${scene.date}` : ""}${scene.location ? `, in ${scene.location}` : ""}):\n\n${scene.text}`;
    const entry: SendLogEntry = { at: new Date().toISOString(), endpoint: "check", scene: scene.title, chars: user.length, ok: false };
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: betaZodOutputFormat(CheckSchema) },
        system: CHECK_SYSTEM,
        messages: [{ role: "user", content: user }],
      });
      if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no result (${res.stop_reason})`);
      entry.ok = true;
      return res.parsed_output.issues.map((i, n) => {
        const spans = i.quotes.map((q) => find(paras, q)).filter((s): s is Span => !!s);
        const fix = i.fix_quote ? find(paras, i.fix_quote, false) : null;
        return {
          key: `ai:${scene.id}:${n}:${i.title}`,
          type: "ai" as const,
          severity: i.severity,
          title: i.title,
          explanation: i.explanation,
          spans,
          suggestions: fix ? [{ label: `Change to "${i.fix_replacement}"`, edits: [{ span: fix, replacement: i.fix_replacement }] }] : [],
        };
      });
    } catch (err) {
      entry.note = describe(err);
      throw err;
    } finally {
      this.log(entry);
    }
  }
}

/** Anchor a model-quoted passage in the scene. Models sometimes alter quotes; unmatched quotes are dropped. */
function find(paras: Paragraph[], quote: string, widen = true): Span | null {
  const q = quote.trim().replace(/^["“]|["”]$/g, "");
  if (!q) return null;
  for (const p of paras) {
    const i = p.text.indexOf(q);
    if (i >= 0) return widen ? sentenceSpan(p, i, i + q.length) : { sceneId: p.sceneId, paraHash: p.hash, start: i, end: i + q.length, quote: q };
  }
  return null;
}

function describe(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited; try again shortly.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
