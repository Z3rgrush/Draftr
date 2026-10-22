// Where projects live. In the desktop app, each project is a plain folder
// (project.json + scenes/*.md) under Documents/Draftr, so authors can back it
// up with any sync tool, and the library is every project folder found there
// plus any opened from elsewhere. In the browser preview, each project is a
// localStorage entry and the library is an index of them.

import { fromFiles, summarize, summarizeManifest, toFiles, type ProjectFiles, type ProjectSummary } from "./core/project";
import type { Project } from "./core/types";

export interface Store {
  readonly kind: "folder" | "browser";
  /** Every project in the library, most recently saved first. */
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<Project | null>;
  save(p: Project): Promise<string>;
  /** Take a project out of the library. Desktop moves its folder to Documents/Draftr/.trash. */
  remove(id: string): Promise<void>;
  /** Desktop only: pick an existing project folder and add it to the library. */
  open?(): Promise<Project | null>;
  /** Desktop only: write a Markdown export into the project folder. Returns its path. */
  exportMarkdown?(p: Project, text: string): Promise<string>;
  where(): string;
}

const DIR = "draftr:dir:";
const LEGACY_KEY = "draftr:project";
const INDEX = "draftr:library";
const PROJECT = "draftr:project:";

const byRecent = (a: ProjectSummary, b: ProjectSummary) => b.updated - a.updated;

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode or storage blocked: keep working in memory */
  }
}

function safeRemove(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* nothing stored, nothing to remove */
  }
}
function safeKeys(): string[] {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}

export function isDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class BrowserStore implements Store {
  readonly kind = "browser" as const;

  constructor() {
    // Before the library, the preview kept a single project under one key.
    const legacy = safeGet(LEGACY_KEY);
    if (legacy) {
      try {
        const p = fromFiles(JSON.parse(legacy) as ProjectFiles);
        if (!safeGet(PROJECT + p.id)) {
          safeSet(PROJECT + p.id, legacy);
          this.writeIndex([...this.index().filter((x) => x.id !== p.id), summarize(p, Date.now())]);
        }
        safeRemove(LEGACY_KEY);
      } catch {
        /* unreadable: leave it where it is */
      }
    }
  }

  private index(): ProjectSummary[] {
    try {
      const list = JSON.parse(safeGet(INDEX) ?? "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  private writeIndex(list: ProjectSummary[]) {
    safeSet(INDEX, JSON.stringify(list));
  }

  async list() {
    return this.index().filter((x) => safeGet(PROJECT + x.id)).sort(byRecent);
  }
  async load(id: string) {
    const raw = safeGet(PROJECT + id);
    if (!raw) return null;
    try {
      return fromFiles(JSON.parse(raw) as ProjectFiles);
    } catch {
      return null;
    }
  }
  async save(p: Project) {
    safeSet(PROJECT + p.id, JSON.stringify(toFiles(p)));
    this.writeIndex([...this.index().filter((x) => x.id !== p.id), summarize(p, Date.now())]);
    return "this browser";
  }
  async remove(id: string) {
    safeRemove(PROJECT + id);
    this.writeIndex(this.index().filter((x) => x.id !== id));
  }
  where() {
    return "Saved in this browser";
  }
}

class FolderStore implements Store {
  readonly kind = "folder" as const;
  private dir = "";

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  async list() {
    // Folders opened from outside Documents/Draftr are remembered by id.
    const known = safeKeys().filter((k) => k.startsWith(DIR)).map((k) => safeGet(k)!).filter(Boolean);
    const entries = await this.invoke<{ dir: string; manifest: string; modified: number }[]>("list_projects", { extra: known });
    const seen = new Set<string>();
    const out: ProjectSummary[] = [];
    for (const e of entries) {
      const sum = summarizeManifest(e.manifest, e.modified);
      // A copied folder shares its id with the original; list the one already known.
      if (!sum || seen.has(sum.id)) continue;
      const mapped = safeGet(DIR + sum.id);
      if (mapped && mapped !== e.dir && entries.some((x) => x.dir === mapped)) continue;
      seen.add(sum.id);
      safeSet(DIR + sum.id, e.dir);
      out.push(sum);
    }
    return out.sort(byRecent);
  }

  async load(id: string) {
    const dir = safeGet(DIR + id);
    if (!dir) return null;
    try {
      const p = fromFiles(await this.invoke<ProjectFiles>("load_project", { dir }));
      this.dir = dir;
      return p;
    } catch {
      return null;
    }
  }

  async save(p: Project) {
    // Each project keeps the folder it was first saved to or opened from.
    let dir = safeGet(DIR + p.id);
    if (!dir) {
      const root = await this.invoke<string>("projects_root");
      const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "novel";
      dir = `${root}/${slug}-${p.id}`;
      safeSet(DIR + p.id, dir);
    }
    this.dir = dir;
    await this.invoke("save_project", { dir, files: toFiles(p) });
    return dir;
  }

  async remove(id: string) {
    const dir = safeGet(DIR + id);
    if (!dir) return;
    await this.invoke<string>("trash_project", { dir });
    safeRemove(DIR + id);
    if (this.dir === dir) this.dir = "";
  }

  async open() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "Open a Draftr project folder" });
    if (typeof dir !== "string") return null;
    const p = fromFiles(await this.invoke<ProjectFiles>("load_project", { dir }));
    this.dir = dir;
    safeSet(DIR + p.id, dir);
    return p;
  }

  async exportMarkdown(p: Project, text: string) {
    const dir = await this.save(p);
    const name = (p.title.replace(/[^\w\- ]+/g, "").trim() || "manuscript") + ".md";
    return this.invoke<string>("export_file", { dir, name, content: text });
  }

  where() {
    return this.dir ? `Saved to ${this.dir}` : "Not saved yet";
  }
}

export function createStore(): Store {
  return isDesktop() ? new FolderStore() : new BrowserStore();
}

export function getPref(k: string) {
  return safeGet("draftr:" + k);
}
export function setPref(k: string, v: string) {
  safeSet("draftr:" + k, v);
}
