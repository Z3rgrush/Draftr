// Where projects live. In the desktop app, each project is a plain folder
// (project.json + scenes/*.md) under Documents/Margin, so authors can back it
// up with any sync tool. In the browser preview, it falls back to localStorage.

import { fromFiles, toFiles, type ProjectFiles } from "./core/project";
import type { Project } from "./core/types";

export interface Store {
  readonly kind: "folder" | "browser";
  load(): Promise<Project | null>;
  save(p: Project): Promise<string>;
  /** Desktop only: pick an existing project folder. */
  open?(): Promise<Project | null>;
  /** Desktop only: write a Markdown export into the project folder. Returns its path. */
  exportMarkdown?(p: Project, text: string): Promise<string>;
  where(): string;
}

const LAST = "margin:last-project-dir";
const KEY = "margin:project";

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

export function isDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class BrowserStore implements Store {
  readonly kind = "browser" as const;
  async load() {
    const raw = safeGet(KEY);
    if (!raw) return null;
    try {
      return fromFiles(JSON.parse(raw) as ProjectFiles);
    } catch {
      return null;
    }
  }
  async save(p: Project) {
    safeSet(KEY, JSON.stringify(toFiles(p)));
    return "this browser";
  }
  where() {
    return "Saved in this browser";
  }
}

class FolderStore implements Store {
  readonly kind = "folder" as const;
  private dir = safeGet(LAST) ?? "";

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  async load() {
    if (!this.dir) return null;
    try {
      return fromFiles(await this.invoke<ProjectFiles>("load_project", { dir: this.dir }));
    } catch {
      return null;
    }
  }

  async save(p: Project) {
    // Each project keeps the folder it was first saved to or opened from.
    let dir = safeGet(`margin:dir:${p.id}`);
    if (!dir) {
      const root = await this.invoke<string>("projects_root");
      const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "novel";
      dir = `${root}/${slug}-${p.id}`;
      safeSet(`margin:dir:${p.id}`, dir);
    }
    this.dir = dir;
    safeSet(LAST, dir);
    await this.invoke("save_project", { dir: this.dir, files: toFiles(p) });
    return this.dir;
  }

  async open() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "Open a Margin project folder" });
    if (typeof dir !== "string") return null;
    const p = fromFiles(await this.invoke<ProjectFiles>("load_project", { dir }));
    this.dir = dir;
    safeSet(LAST, dir);
    safeSet(`margin:dir:${p.id}`, dir);
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
  return safeGet("margin:" + k);
}
export function setPref(k: string, v: string) {
  safeSet("margin:" + k, v);
}
