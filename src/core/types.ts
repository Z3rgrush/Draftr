// The story model. Everything the app knows is entities and facts, and every
// fact points back to the passage that supports it (a Span).

export type EntityKind = "character" | "place" | "object" | "theme" | "thread";

export interface Scene {
  id: string;
  title: string;
  chapter: number;
  /** Plain text: paragraphs separated by blank lines, *italic* and **bold** inline. */
  text: string;
  pov?: string;
  location?: string;
  /** In-story date as YYYY-MM-DD (or just YYYY). */
  date?: string;
  status?: "draft" | "revised" | "final";
}

/** A passage in the manuscript. paraHash keeps it stable while other paragraphs change. */
export interface Span {
  sceneId: string;
  paraHash: string;
  start: number;
  end: number;
  quote: string;
}

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
}

export type FactStatus = "inferred" | "pinned";

export interface Fact {
  id: string;
  entityId: string;
  /** e.g. "eyes", "hair", "age", "born", "status" */
  attribute: string;
  value: string;
  span: Span;
  /** For values that appear inside the quote (e.g. "green"), where in the quote. Used by suggested edits. */
  valueSpan?: Span;
  confidence: number;
  source: "local" | "ai";
  status: FactStatus;
}

export interface Mention {
  entityId: string;
  span: Span;
  /** True when the entity acts in the passage (speaks, moves), not just gets named. */
  acting: boolean;
}

export interface ThreadBeat {
  kind: "open" | "advance" | "resolve";
  span: Span;
}

export interface PlotThread {
  id: string;
  label: string;
  beats: ThreadBeat[];
}

export type Severity = "high" | "medium" | "low";

export type IssueType =
  | "attribute"
  | "age"
  | "dead-returns"
  | "name-drift"
  | "timeline"
  | "open-thread"
  | "absence"
  | "ai";

export interface Edit {
  span: Span;
  replacement: string;
}

export interface Suggestion {
  label: string;
  edits: Edit[];
  /** A change to a scene's metadata instead of (or as well as) its text. */
  meta?: { sceneId: string; field: "date" | "location"; value: string };
}

export interface Issue {
  /** Stable across re-runs so "intentional" and "dismiss" stick. */
  key: string;
  type: IssueType;
  severity: Severity;
  title: string;
  explanation: string;
  /** The passages in conflict. These are underlined in the manuscript. */
  spans: Span[];
  /** Supporting passages shown on the card but not underlined (the correct spelling, the last sighting). */
  context?: Span[];
  entityId?: string;
  suggestions: Suggestion[];
}

export type IssueDecision = "intentional" | "dismissed";

/** What the author changed in the bible. Always wins over inference. */
export interface BibleEdits {
  /** alias name -> canonical entity name */
  merges: Record<string, string>;
  notEntities: string[];
  renames: Record<string, string>;
  kinds: Record<string, EntityKind>;
  /** factKey (entity|attribute|value) pinned as canon */
  pinned: string[];
  /** Author-defined theme lexicons, merged over the defaults */
  themes: Record<string, string[]>;
}

export type FlagMode = "quiet" | "gentle" | "editor";

export interface Settings {
  mode: FlagMode;
  /** Flag a recurring character absent for more than this share of scenes. */
  absenceShare: number;
  disabledTypes: IssueType[];
  aiEnabled: boolean;
}

export interface Project {
  id: string;
  title: string;
  scenes: Scene[];
  bible: BibleEdits;
  decisions: Record<string, IssueDecision>;
  settings: Settings;
}

export interface StoryModel {
  entities: Entity[];
  facts: Fact[];
  mentions: Mention[];
  threads: PlotThread[];
  /** theme -> sceneId -> hit count */
  themes: Record<string, Record<string, number>>;
}

/** A fact as an extractor reports it, before it is tied to an entity id. */
export interface RawFact {
  entityName: string;
  attribute: string;
  value: string;
  span: Span;
  valueSpan?: Span;
  confidence: number;
  source: "local" | "ai";
}

/** What the AI tier adds for one scene (the shape of Chaptr's proposed POST /extract). */
export interface AiExtraction {
  sceneId: string;
  paraHashes: string[];
  entities: { name: string; kind: EntityKind; aliases: string[] }[];
  facts: RawFact[];
  threadBeats: { label: string; beat: ThreadBeat }[];
}
