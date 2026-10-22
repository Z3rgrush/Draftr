import type { BibleEdits, Project, Scene, Settings } from "./types";

export function defaultBible(): BibleEdits {
  return { merges: {}, notEntities: [], renames: {}, kinds: {}, pinned: [], themes: {} };
}

export function defaultSettings(): Settings {
  // Quiet by default: nothing is shown while the author drafts.
  return { mode: "quiet", absenceShare: 0.4, disabledTypes: [], aiEnabled: false };
}

export function newId(prefix = "s") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

export function newProject(title = "Untitled novel"): Project {
  return {
    id: newId("p"),
    title,
    scenes: [{ id: newId(), title: "Opening", chapter: 1, text: "", status: "draft" }],
    bible: defaultBible(),
    decisions: {},
    settings: defaultSettings(),
  };
}

/**
 * Import a plain-text or Markdown manuscript. Chapters start at lines like
 * "Chapter 3", "# Chapter Three" or "# The Fire"; scenes split at "***", "* * *" or "#".
 */
export function importManuscript(text: string, title: string): Project {
  const p = newProject(title);
  p.scenes = [];
  let chapter = 0;
  let sceneTitle = "";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      p.scenes.push({ id: newId(), title: sceneTitle || `Scene ${p.scenes.length + 1}`, chapter: Math.max(chapter, 1), text: body, status: "draft" });
    }
    buf = [];
    sceneTitle = "";
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{1,2}\s+(.*)$/) ?? line.match(/^(chapter\s+[\w-]+.*)$/i);
    if (heading) {
      flush();
      chapter++;
      sceneTitle = heading[1].replace(/^chapter\s+[\w-]+[:.\s-]*/i, "").trim() || heading[1].trim();
      continue;
    }
    if (/^(\*\s*\*\s*\*|#|~~~|-{3,})$/.test(line)) {
      flush();
      continue;
    }
    buf.push(raw);
  }
  flush();
  if (!p.scenes.length) p.scenes.push({ id: newId(), title: "Opening", chapter: 1, text: "", status: "draft" });
  return p;
}

export function exportMarkdown(project: Project, ordered: Scene[]): string {
  const out = [`# ${project.title}`, ""];
  let ch = -1;
  for (const s of ordered) {
    if (s.chapter !== ch) {
      ch = s.chapter;
      out.push(`## Chapter ${ch}`, "");
    } else out.push("* * *", "");
    out.push(s.text.trim(), "");
  }
  return out.join("\n");
}

/** What the library shows for a project without loading it. */
export interface ProjectSummary {
  id: string;
  title: string;
  words: number;
  scenes: number;
  /** Last saved, ms since the epoch; 0 if unknown. */
  updated: number;
}

export function countWords(scenes: Scene[]) {
  return scenes.reduce((n, s) => n + (s.text.match(/\S+/g) ?? []).length, 0);
}

export function summarize(p: Project, updated = 0): ProjectSummary {
  return { id: p.id, title: p.title, words: countWords(p.scenes), scenes: p.scenes.length, updated };
}

/** Read a summary straight from a project.json manifest. */
export function summarizeManifest(manifest: string, updated = 0): ProjectSummary | null {
  try {
    const m = JSON.parse(manifest);
    if (typeof m.id !== "string") return null;
    return { id: m.id, title: typeof m.title === "string" ? m.title : "Untitled novel", words: typeof m.words === "number" ? m.words : 0, scenes: Array.isArray(m.sceneFiles) ? m.sceneFiles.length : 0, updated };
  } catch {
    return null;
  }
}

/** The on-disk project folder: a manifest plus one Markdown-with-frontmatter file per scene. */
export interface ProjectFiles {
  manifest: string;
  scenes: { file: string; content: string }[];
}

export function toFiles(project: Project): ProjectFiles {
  const { scenes, ...rest } = project;
  const files = scenes.map((s, i) => {
    const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scene";
    const file = `${String(i + 1).padStart(3, "0")}-${slug}.md`;
    const fm = [
      "---",
      `id: ${s.id}`,
      `title: ${JSON.stringify(s.title)}`,
      `chapter: ${s.chapter}`,
      s.pov ? `pov: ${JSON.stringify(s.pov)}` : null,
      s.location ? `location: ${JSON.stringify(s.location)}` : null,
      s.date ? `date: ${s.date}` : null,
      `status: ${s.status ?? "draft"}`,
      "---",
      "",
    ]
      .filter((x) => x !== null)
      .join("\n");
    return { file, content: fm + s.text.trim() + "\n" };
  });
  // `words` lets the library list a project without reading its scenes.
  const manifest = JSON.stringify({ format: "draftr-project/1", ...rest, words: countWords(scenes), sceneFiles: files.map((f) => f.file) }, null, 2);
  return { manifest, scenes: files };
}

export function fromFiles(files: ProjectFiles): Project {
  const m = JSON.parse(files.manifest);
  const byName = new Map(files.scenes.map((f) => [f.file, f.content]));
  const scenes: Scene[] = (m.sceneFiles as string[]).filter((f) => byName.has(f)).map((f) => parseScene(byName.get(f)!));
  delete m.sceneFiles;
  delete m.format;
  delete m.words;
  return { ...m, scenes, bible: { ...defaultBible(), ...m.bible }, settings: { ...defaultSettings(), ...m.settings } };
}

function parseScene(content: string): Scene {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2];
    }
  }
  return {
    id: meta.id ?? newId(),
    title: meta.title ?? "Untitled",
    chapter: parseInt(meta.chapter ?? "1", 10),
    pov: meta.pov,
    location: meta.location,
    date: meta.date,
    status: (meta.status as Scene["status"]) ?? "draft",
    text: (m ? content.slice(m[0].length) : content).trim(),
  };
}
