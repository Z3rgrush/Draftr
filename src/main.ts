import "./styles.css";
import { ClaudeStandIn, type SendLogEntry, type StoryAI } from "./core/ai";
import { runChecks } from "./core/checks";
import { applySuggestion, locate, restoreScenes } from "./core/edits";
import { buildModel, factKey, orderedScenes, presence } from "./core/model";
import { importDocx } from "./core/docx";
import { exportMarkdown, importManuscript, newId, newProject, summarize, type ProjectSummary } from "./core/project";
import { fnv1a, yearOf } from "./core/text";
import type { AiExtraction, Entity, EntityKind, FlagMode, Issue, IssueType, Project, Scene, Severity, Span, StoryModel, Suggestion } from "./core/types";
import { sampleProject } from "./data/sample";
import { createStore, getPref, isDesktop, setPref } from "./storage";
import { clear, h, words } from "./ui/dom";
import { ManuscriptEditor } from "./ui/editor";

type Tab = "issues" | "bible" | "tracking" | "settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = createStore();

const state = {
  project: sampleProject() as Project,
  model: { entities: [], facts: [], mentions: [], threads: [], themes: {} } as StoryModel,
  ruleIssues: [] as Issue[],
  /** AI check results per scene, valid while the scene text hash matches. */
  aiIssues: new Map<string, { hash: string; issues: Issue[] }>(),
  aiCache: {} as Record<string, AiExtraction & { textHash: string }>,
  aiBusy: new Set<string>(),
  aiError: "",
  log: [] as SendLogEntry[],
  activeId: "",
  tab: "issues" as Tab,
  panelOpen: true,
  binderOpen: true,
  focus: false,
  openIssue: "",
  showDecided: false,
  bibleQuery: "",
  bibleKind: "all" as EntityKind | "all",
  analysisMs: 0,
  saveText: "",
  /** Unsaved edits to the open project. */
  dirty: false,
  libraryOpen: false,
  library: [] as ProjectSummary[],
  renaming: "",
};

const editor = new ManuscriptEditor(
  $("editor"),
  (text) => {
    const s = active();
    if (!s) return;
    s.text = text;
    renderStatus();
    scheduleAnalysis();
    scheduleSave();
  },
  (key) => openIssue(key),
);

// ---------- helpers

function active(): Scene | undefined {
  return state.project.scenes.find((s) => s.id === state.activeId);
}

function scenesInOrder() {
  return orderedScenes(state.project);
}

function sceneOf(span: Span) {
  return state.project.scenes.find((s) => s.id === span.sceneId);
}

function allIssues(): Issue[] {
  const ai: Issue[] = [];
  for (const [id, v] of state.aiIssues) {
    const s = state.project.scenes.find((x) => x.id === id);
    if (s && fnv1a(s.text) === v.hash) ai.push(...v.issues);
  }
  return [...state.ruleIssues, ...ai];
}

function openIssues() {
  return allIssues().filter((i) => !state.project.decisions[i.key]);
}

const SEV_ORDER: Severity[] = ["high", "medium", "low"];
const TYPE_LABEL: Record<IssueType, string> = {
  attribute: "Attribute",
  age: "Age and dates",
  "dead-returns": "Dead character",
  "name-drift": "Name spelling",
  timeline: "Timeline",
  "open-thread": "Plot thread",
  absence: "Absence",
  ai: "AI check",
};

function toast(msg: string, action?: { label: string; run: () => void }) {
  const el = $("toast");
  clear(el, h("span", null, msg), action && h("button", { onclick: () => (action.run(), (el.hidden = true)) }, action.label));
  el.hidden = false;
  clearTimeout((toast as any).t);
  (toast as any).t = setTimeout(() => (el.hidden = true), 8000);
}

// ---------- analysis

let analysisTimer = 0;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  // Run when the author pauses, never on every keystroke.
  analysisTimer = window.setTimeout(analyse, 1500);
}

function analyse() {
  const t0 = performance.now();
  const ai: Record<string, AiExtraction> = {};
  for (const [id, x] of Object.entries(state.aiCache)) {
    if (state.project.scenes.some((s) => s.id === id)) ai[id] = x;
  }
  state.model = buildModel(state.project, ai);
  state.ruleIssues = runChecks(state.project, state.model);
  state.analysisMs = performance.now() - t0;
  renderAll();
  maybeExtractWithAI();
}

// ---------- AI tier

function ai(): StoryAI | null {
  const key = getPref("api-key");
  if (!state.project.settings.aiEnabled || !key) return null;
  return new ClaudeStandIn(key, (e) => {
    state.log.unshift(e);
    if (state.tab === "settings") renderPanel();
  });
}

let aiTimer = 0;
function maybeExtractWithAI() {
  clearTimeout(aiTimer);
  const client = ai();
  const s = active();
  if (!client || !s || !s.text.trim()) return;
  const hash = fnv1a(s.text);
  if (state.aiCache[s.id]?.textHash === hash || state.aiBusy.has(s.id)) return;
  // Extraction is per changed scene and waits for a longer pause than rule checks.
  aiTimer = window.setTimeout(() => extractScene(client, s), 4000);
}

async function extractScene(client: StoryAI, s: Scene) {
  const hash = fnv1a(s.text);
  state.aiBusy.add(s.id);
  renderStatus();
  try {
    const x = await client.extract(s, state.model.entities);
    state.aiCache[s.id] = { ...x, textHash: hash };
    state.aiError = "";
  } catch (e) {
    state.aiError = e instanceof Error ? e.message : String(e);
  } finally {
    state.aiBusy.delete(s.id);
  }
  analyse();
}

async function extractAll() {
  const client = ai();
  if (!client) return toast("Turn on the AI tier and add an API key in Settings first.");
  for (const s of scenesInOrder()) {
    if (!s.text.trim() || state.aiCache[s.id]?.textHash === fnv1a(s.text)) continue;
    await extractScene(client, s);
  }
  toast("AI reading pass finished.");
}

async function deepCheck(s: Scene) {
  const client = ai();
  if (!client) return toast("Turn on the AI tier and add an API key in Settings first.");
  state.aiBusy.add(s.id);
  renderStatus();
  renderPanel();
  try {
    const issues = await client.check(s, {
      facts: state.model.facts,
      entities: state.model.entities,
      sceneTitles: new Map(state.project.scenes.map((x) => [x.id, `ch. ${x.chapter} "${x.title}"`])),
    });
    state.aiIssues.set(s.id, { hash: fnv1a(s.text), issues });
    state.aiError = "";
    toast(issues.length ? `AI check found ${issues.length} issue${issues.length > 1 ? "s" : ""} in "${s.title}".` : `AI check found nothing in "${s.title}".`);
  } catch (e) {
    state.aiError = e instanceof Error ? e.message : String(e);
    toast(`AI check failed: ${state.aiError}`);
  } finally {
    state.aiBusy.delete(s.id);
  }
  renderAll();
}

// ---------- saving

let saveTimer = 0;
function scheduleSave() {
  state.dirty = true;
  state.saveText = "Editing…";
  $("save-status").textContent = state.saveText;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 1000);
}

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    state.dirty = false;
    await store.save(state.project);
    state.saveText = store.kind === "folder" ? "Saved" : "Saved in this browser";
  } catch (e) {
    state.dirty = true;
    state.saveText = "Not saved: " + (e instanceof Error ? e.message : String(e));
  }
  $("save-status").textContent = state.saveText;
  $("save-status").title = store.where();
}

// ---------- actions

function selectScene(id: string, reveal?: Span) {
  if (id !== state.activeId) {
    state.activeId = id;
    setPref(`active-scene:${state.project.id}`, id);
    const s = active();
    editor.load(s?.text ?? "");
    renderBinder();
    renderSceneHead();
  }
  renderUnderlines(reveal);
  if (reveal) editor.reveal(reveal);
  renderStatus();
}

function jump(span: Span) {
  selectScene(span.sceneId, span);
}

function openIssue(key: string) {
  state.openIssue = key;
  state.tab = "issues";
  state.panelOpen = true;
  renderLayout();
  renderPanel();
  document.querySelector(`[data-card="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function apply(issue: Issue, s: Suggestion) {
  const { before, applied, skipped } = applySuggestion(state.project, s);
  const a = active();
  if (a && before.some((b) => b.id === a.id)) {
    editor.load(a.text);
    renderSceneHead();
  }
  analyse();
  scheduleSave();
  toast(`Applied ${applied} change${applied === 1 ? "" : "s"}${skipped ? ` (${skipped} passage${skipped > 1 ? "s" : ""} had moved and were skipped)` : ""}.`, {
    label: "Undo",
    run: () => {
      restoreScenes(state.project, before);
      const now = active();
      if (now) editor.load(now.text);
      renderSceneHead();
      analyse();
      scheduleSave();
    },
  });
  void issue;
}

function decide(issue: Issue, d: "intentional" | "dismissed" | null) {
  if (d) state.project.decisions[issue.key] = d;
  else delete state.project.decisions[issue.key];
  renderAll();
  scheduleSave();
}

function bibleChanged() {
  analyse();
  scheduleSave();
}

function setMode(m: FlagMode) {
  state.project.settings.mode = m;
  if (m === "editor") state.panelOpen = true;
  renderAll();
  scheduleSave();
}

function loadProject(p: Project) {
  clearTimeout(saveTimer);
  state.project = p;
  state.dirty = false;
  state.saveText = "";
  $("save-status").textContent = "";
  setPref("last-project", p.id);
  setLibrary(false);
  state.aiCache = {};
  state.aiIssues.clear();
  state.openIssue = "";
  const first = scenesInOrder()[0];
  state.activeId = "";
  state.panelOpen = p.settings.mode !== "quiet";
  const last = getPref(`active-scene:${p.id}`);
  selectScene(p.scenes.some((s) => s.id === last) ? last! : (first?.id ?? ""));
  analyse();
}

function addScene(newChapter: boolean) {
  const cur = active();
  const ch = newChapter ? Math.max(0, ...state.project.scenes.map((s) => s.chapter)) + 1 : (cur?.chapter ?? 1);
  const s: Scene = { id: newId(), title: newChapter ? `Chapter ${ch}` : "New scene", chapter: ch, text: "", status: "draft", pov: cur?.pov, location: cur?.location, date: cur?.date };
  const i = cur && !newChapter ? state.project.scenes.indexOf(cur) + 1 : state.project.scenes.length;
  state.project.scenes.splice(i, 0, s);
  selectScene(s.id);
  analyse();
  scheduleSave();
  editor.focus();
}

function moveScene(dir: -1 | 1) {
  const list = state.project.scenes;
  const cur = active();
  if (!cur) return;
  const sameCh = scenesInOrder().filter((s) => s.chapter === cur.chapter);
  const k = sameCh.indexOf(cur);
  if (k + dir < 0 || k + dir >= sameCh.length) {
    cur.chapter = Math.max(1, cur.chapter + dir);
  } else {
    const other = sameCh[k + dir];
    const a = list.indexOf(cur);
    const b = list.indexOf(other);
    [list[a], list[b]] = [list[b], list[a]];
  }
  renderBinder();
  renderSceneHead();
  analyse();
  scheduleSave();
}

let pendingDelete = "";
function deleteScene() {
  const cur = active();
  if (!cur) return;
  if (pendingDelete !== cur.id) {
    pendingDelete = cur.id;
    renderSceneHead();
    return;
  }
  const order = scenesInOrder();
  const i = order.indexOf(cur);
  const removed = { ...cur };
  const at = state.project.scenes.indexOf(cur);
  state.project.scenes = state.project.scenes.filter((s) => s !== cur);
  if (!state.project.scenes.length) state.project.scenes.push({ id: newId(), title: "Opening", chapter: 1, text: "" });
  pendingDelete = "";
  state.activeId = "";
  selectScene((order[i + 1] ?? order[i - 1] ?? scenesInOrder()[0]).id);
  analyse();
  scheduleSave();
  toast(`Deleted "${removed.title}".`, {
    label: "Undo",
    run: () => {
      state.project.scenes.splice(at, 0, removed);
      selectScene(removed.id);
      analyse();
      scheduleSave();
    },
  });
}

function download(name: string, text: string, type = "text/markdown") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function importFile() {
  const input = h("input", { type: "file", accept: ".docx,.txt,.md,.markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    const name = f.name.replace(/\.[^.]+$/, "");
    let p: Project;
    let how = "";
    if (/\.docx?$/i.test(f.name)) {
      try {
        const r = importDocx(new Uint8Array(await f.arrayBuffer()), name);
        p = r.project;
        if (r.splitBy === "none") how = " No chapter headings were found, so it came in as one chapter; use Heading 1 for chapters in Word to split it.";
      } catch (e) {
        return toast(e instanceof Error ? e.message : String(e));
      }
    } else p = importManuscript(await f.text(), name);
    // Opening the project runs the continuity checks on the whole manuscript.
    await startProject(p);
    const chapters = new Set(p.scenes.map((s) => s.chapter)).size;
    const n = openIssues().length;
    const found = n ? ` Found ${n} possible continuity issue${n > 1 ? "s" : ""}.` : " No continuity issues found.";
    toast(
      `Imported ${chapters} chapter${chapters > 1 ? "s" : ""} and ${p.scenes.length} scene${p.scenes.length > 1 ? "s" : ""} from ${f.name}.${found}${how} Add each scene's date and location to turn on timeline checks.`,
      n > 0 ? { label: "Show issues", run: () => ((state.tab = "issues"), setMode("editor")) } : undefined,
    );
  });
  input.click();
}

// ---------- library

/** Save the open project before another one replaces it. */
async function leaveProject() {
  if (state.dirty) await saveNow();
}

async function switchTo(id: string) {
  if (id === state.project.id) return setLibrary(false);
  await leaveProject();
  const p = await store.load(id);
  if (!p) return toast("That project could not be opened. Its folder may have moved.");
  loadProject(p);
}

async function startProject(p: Project) {
  await leaveProject();
  loadProject(p);
  await saveNow();
}

async function openFolder() {
  await leaveProject();
  try {
    const p = await store.open!();
    if (p) loadProject(p);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

async function renameProject(id: string, title: string) {
  state.renaming = "";
  title = title.trim();
  if (!title) return renderLibrary();
  if (id === state.project.id) {
    state.project.title = title;
    renderLayout();
    await saveNow();
  } else {
    const p = await store.load(id);
    if (p) {
      p.title = title;
      await store.save(p);
    }
  }
  await refreshLibrary();
}

let pendingProjectDelete = "";
async function deleteProject(id: string) {
  if (pendingProjectDelete !== id) {
    pendingProjectDelete = id;
    return renderLibrary();
  }
  pendingProjectDelete = "";
  const current = id === state.project.id;
  // A pending autosave must not bring the deleted project back.
  if (current) clearTimeout(saveTimer);
  const removed = current ? state.project : await store.load(id);
  if (!removed) return;
  try {
    await store.remove(id);
  } catch (e) {
    return toast(`Could not delete: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (current) {
    // Keep the editor on something: the most recent other novel, or a blank one.
    const next = (await store.list())[0];
    const p = next ? await store.load(next.id) : null;
    loadProject(p ?? newProject());
    if (!p) await saveNow();
    setLibrary(true);
  }
  await refreshLibrary();
  toast(`Deleted "${removed.title}".${store.kind === "folder" ? " Its folder is in Documents/Draftr/.trash." : ""}`, {
    label: "Undo",
    run: async () => {
      await store.save(removed);
      await refreshLibrary();
    },
  });
}

function setLibrary(open: boolean) {
  state.libraryOpen = open;
  state.renaming = "";
  pendingProjectDelete = "";
  $("library").hidden = !open;
  $("app").classList.toggle("library-open", open);
  if (open) refreshLibrary();
}

async function refreshLibrary() {
  try {
    state.library = await store.list();
  } catch (e) {
    toast(`Could not read the library: ${e instanceof Error ? e.message : String(e)}`);
  }
  renderLibrary();
}

function ago(ms: number) {
  if (!ms) return "";
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "edited just now";
  if (min < 60) return `edited ${min} min ago`;
  if (min < 60 * 24) return `edited ${Math.round(min / 60)} h ago`;
  return `edited ${new Date(ms).toLocaleDateString()}`;
}

function renderLibrary() {
  if (!state.libraryOpen) return;
  // The open project is listed from memory, so unsaved titles and counts are current.
  const live = summarize(state.project, state.library.find((x) => x.id === state.project.id)?.updated ?? Date.now());
  const list = [live, ...state.library.filter((x) => x.id !== live.id)];
  const saved = new Set(state.library.map((x) => x.id));
  clear(
    $("library"),
    h(
      "div",
      { class: "library-inner" },
      h(
        "header",
        { class: "library-head" },
        h("h1", null, "Your novels"),
        h("span", { class: "muted small" }, `${list.length} project${list.length === 1 ? "" : "s"}`),
        h("div", { class: "spacer" }),
        h("button", { class: "icon", title: "Back to the open novel (Esc)", onclick: () => setLibrary(false) }, "Close"),
      ),
      h(
        "div",
        { class: "actions wrap" },
        h("button", { class: "primary", onclick: () => startProject(newProject()) }, "New novel"),
        h("button", { onclick: importFile }, "Import .docx, .txt or .md…"),
        store.open ? h("button", { onclick: openFolder }, "Open project folder…") : null,
        h("button", { onclick: () => startProject(sampleProject()) }, "Add the sample"),
      ),
      h(
        "div",
        { class: "library-list" },
        list.map((x) => {
          const current = x.id === state.project.id;
          const meta = [`${x.words.toLocaleString()} words`, `${x.scenes} scene${x.scenes === 1 ? "" : "s"}`, saved.has(x.id) ? ago(x.updated) : "not saved yet"].filter(Boolean).join(" · ");
          return h(
            "div",
            { class: "card project-card" + (current ? " open" : ""), "data-project": x.id },
            state.renaming === x.id
              ? h("input", {
                  class: "project-rename",
                  value: x.title,
                  "aria-label": "New title",
                  onkeydown: (e: KeyboardEvent) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") (e.stopPropagation(), (state.renaming = ""), renderLibrary());
                  },
                  onblur: (e: Event) => state.renaming === x.id && renameProject(x.id, (e.target as HTMLInputElement).value),
                })
              : h("button", { class: "project-open", onclick: () => switchTo(x.id) }, h("span", { class: "project-name" }, x.title || "Untitled novel"), current ? h("span", { class: "muted small" }, "Open now") : null),
            h("p", { class: "muted small" }, meta),
            h(
              "div",
              { class: "actions" },
              h("button", { class: "linkish", onclick: () => ((state.renaming = x.id), renderLibrary(), document.querySelector<HTMLInputElement>(".project-rename")?.select()) }, "Rename"),
              h(
                "button",
                { class: "linkish danger" + (pendingProjectDelete === x.id ? " armed" : ""), onclick: () => deleteProject(x.id) },
                pendingProjectDelete === x.id ? "Click again to delete" : "Delete",
              ),
            ),
          );
        }),
      ),
    ),
  );
}

// ---------- rendering

function renderAll() {
  renderLayout();
  renderBinder();
  renderSceneHead();
  renderUnderlines();
  renderBadge();
  renderPanel();
  renderStatus();
}

function renderLayout() {
  const app = $("app");
  app.classList.toggle("focus", state.focus);
  app.classList.toggle("no-panel", !state.panelOpen);
  app.classList.toggle("no-binder", !state.binderOpen);
  for (const b of $("mode").querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === state.project.settings.mode);
  for (const b of $("tabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  $("toggle-panel").classList.toggle("on", state.panelOpen);
  const title = $<HTMLInputElement>("project-title");
  if (document.activeElement !== title) title.value = state.project.title;
}

function renderBadge() {
  const b = $<HTMLButtonElement>("badge");
  const n = openIssues().length;
  const mode = state.project.settings.mode;
  b.hidden = mode === "quiet" || n === 0;
  b.textContent = `${n} note${n === 1 ? "" : "s"}`;
}

function renderUnderlines(flash?: Span) {
  const s = active();
  const show = state.project.settings.mode === "editor";
  const list = show && s
    ? openIssues().flatMap((i) => i.spans.filter((sp) => sp.sceneId === s.id).map((span) => ({ span, severity: i.severity, key: i.key })))
    : [];
  editor.setUnderlines(list, flash);
}

function renderBinder() {
  const el = $("binder");
  const mode = state.project.settings.mode;
  const counts = new Map<string, number>();
  if (mode !== "quiet") for (const i of openIssues()) for (const id of new Set(i.spans.map((s) => s.sceneId))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const byCh = new Map<number, Scene[]>();
  for (const s of scenesInOrder()) byCh.set(s.chapter, [...(byCh.get(s.chapter) ?? []), s]);
  clear(
    el,
    h("div", { class: "binder-head" }, h("span", { class: "label" }, "Manuscript"), h("span", { class: "muted small" }, `${words(state.project.scenes.map((s) => s.text).join(" ")).toLocaleString()} words`)),
    h(
      "div",
      { class: "binder-list" },
      [...byCh].map(([ch, list]) =>
        h(
          "div",
          { class: "chapter" },
          h("div", { class: "chapter-title" }, `Chapter ${ch}`),
          list.map((s) =>
            h(
              "button",
              { class: "scene-item" + (s.id === state.activeId ? " on" : ""), onclick: () => selectScene(s.id) },
              h("span", { class: `dot status-${s.status ?? "draft"}`, title: s.status ?? "draft" }),
              h("span", { class: "scene-name" }, s.title || "Untitled"),
              counts.get(s.id) ? h("span", { class: "count", title: "Open issues in this scene" }, counts.get(s.id)) : null,
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "binder-actions" },
      h("button", { onclick: () => addScene(false) }, "+ Scene"),
      h("button", { onclick: () => addScene(true) }, "+ Chapter"),
    ),
  );
}

function renderSceneHead() {
  const s = active();
  const el = $("scene-head");
  if (!s) return clear(el);
  const chars = state.model.entities.filter((e) => e.kind === "character").map((e) => e.name);
  const places = state.model.entities.filter((e) => e.kind === "place").map((e) => e.name);
  const field = (label: string, key: "pov" | "location" | "date", list: string[], placeholder: string) =>
    h(
      "label",
      { class: "meta" },
      h("span", null, label),
      h("input", {
        value: s[key] ?? "",
        placeholder,
        list: list.length ? `dl-${key}` : undefined,
        onchange: (e: Event) => {
          s[key] = (e.target as HTMLInputElement).value.trim() || undefined;
          analyse();
          scheduleSave();
        },
      }),
      list.length ? h("datalist", { id: `dl-${key}` }, list.map((v) => h("option", { value: v }))) : null,
    );
  clear(
    el,
    h("input", {
      class: "scene-title",
      value: s.title,
      "aria-label": "Scene title",
      oninput: (e: Event) => {
        s.title = (e.target as HTMLInputElement).value;
        renderBinder();
        scheduleSave();
      },
    }),
    h(
      "div",
      { class: "meta-row" },
      h(
        "label",
        { class: "meta narrow" },
        h("span", null, "Ch."),
        h("input", {
          type: "number",
          min: 1,
          value: s.chapter,
          onchange: (e: Event) => {
            s.chapter = Math.max(1, parseInt((e.target as HTMLInputElement).value, 10) || 1);
            renderBinder();
            analyse();
            scheduleSave();
          },
        }),
      ),
      field("POV", "pov", chars, "Whose eyes?"),
      field("Where", "location", places, "Place"),
      field("When", "date", [], "YYYY-MM-DD"),
      h(
        "label",
        { class: "meta" },
        h("span", null, "Status"),
        h(
          "select",
          {
            onchange: (e: Event) => {
              s.status = (e.target as HTMLSelectElement).value as Scene["status"];
              renderBinder();
              scheduleSave();
            },
          },
          (["draft", "revised", "final"] as const).map((v) => h("option", { value: v, selected: s.status === v }, v)),
        ),
      ),
      h(
        "div",
        { class: "scene-tools" },
        h("button", { class: "icon", title: "Move up", onclick: () => moveScene(-1) }, "↑"),
        h("button", { class: "icon", title: "Move down", onclick: () => moveScene(1) }, "↓"),
        h("button", { class: "icon danger" + (pendingDelete === s.id ? " armed" : ""), title: "Delete scene", onclick: deleteScene }, pendingDelete === s.id ? "Delete?" : "✕"),
      ),
    ),
  );
}

function renderStatus() {
  const s = active();
  const total = words(state.project.scenes.map((x) => x.text).join(" "));
  const busy = state.aiBusy.size ? ` · AI reading ${[...state.aiBusy].map((id) => state.project.scenes.find((x) => x.id === id)?.title).join(", ")}…` : "";
  $("status").textContent = `${s ? words(s.text).toLocaleString() : 0} words in this scene · ${total.toLocaleString()} in the book · checked in ${Math.round(state.analysisMs)} ms${busy}${state.aiError ? ` · AI: ${state.aiError}` : ""}`;
}

function renderPanel() {
  const body = $("panel-body");
  const scroll = body.scrollTop;
  if (state.tab === "issues") renderIssues(body);
  else if (state.tab === "bible") renderBible(body);
  else if (state.tab === "tracking") renderTracking(body);
  else renderSettings(body);
  body.scrollTop = scroll;
}

const clip = (q: string) => (q.length > 220 ? q.slice(0, 217) + "…" : q);

function quoteBlock(span: Span, context = false) {
  const s = sceneOf(span);
  return h(
    "button",
    { class: "quote" + (context ? " context" : ""), onclick: () => jump(span), title: "Jump to this passage" },
    h("span", { class: "q" }, /^["“]/.test(span.quote) ? clip(span.quote) : `“${clip(span.quote)}”`),
    h("span", { class: "where" }, s ? `Ch. ${s.chapter} · ${s.title}` : "Deleted scene"),
  );
}

/** Show an edit as a small diff in context, e.g. "…her ~~brown~~ green eyes…". */
function diffLine(s: Suggestion) {
  return s.edits.slice(0, 3).map((e) => {
    const scene = sceneOf(e.span);
    const at = scene && locate(scene, e.span);
    if (!scene || !at) return null;
    const para = scene.text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)[at.para];
    // About four words of context either side, cut at word boundaries.
    const pre = para.slice(Math.max(0, at.start - 32), at.start).replace(/^\S*\s/, "");
    const post = para.slice(at.end, at.end + 32).replace(/\s\S*$/, "");
    return h("div", { class: "diff" }, h("span", { class: "muted" }, `ch. ${scene.chapter}: …${pre}`), h("del", null, para.slice(at.start, at.end)), h("ins", null, e.replacement), h("span", { class: "muted" }, `${post}…`));
  });
}

function issueCard(i: Issue) {
  const decided = state.project.decisions[i.key];
  return h(
    "article",
    { class: `card sev-${i.severity}` + (state.openIssue === i.key ? " open" : ""), "data-card": i.key },
    h("header", null, h("span", { class: `sev ${i.severity}`, title: `${i.severity} severity` }), h("h3", null, i.title), h("span", { class: "type" }, TYPE_LABEL[i.type])),
    h("p", null, i.explanation),
    h("div", { class: "quotes" }, i.spans.map((s) => quoteBlock(s)), (i.context ?? []).map((c) => quoteBlock(c, true))),
    decided
      ? h("div", { class: "actions" }, h("span", { class: "muted small" }, decided === "intentional" ? "Marked intentional" : "Dismissed"), h("button", { onclick: () => decide(i, null) }, "Restore"))
      : [
          i.suggestions.map((s) =>
            h("div", { class: "suggestion" }, h("button", { class: "primary", onclick: () => apply(i, s) }, s.label), s.edits.length ? diffLine(s) : null),
          ),
          h(
            "div",
            { class: "actions" },
            h("button", { onclick: () => decide(i, "intentional"), title: "It's meant to be like this. Don't flag it again." }, "Intentional"),
            h("button", { onclick: () => decide(i, "dismissed"), title: "Not a real problem." }, "Dismiss"),
          ),
        ],
  );
}

function renderIssues(el: HTMLElement) {
  const all = allIssues();
  const open = all.filter((i) => !state.project.decisions[i.key]);
  const decided = all.filter((i) => state.project.decisions[i.key]);
  const s = active();
  const aiOn = state.project.settings.aiEnabled && !!getPref("api-key");
  clear(
    el,
    h(
      "div",
      { class: "panel-intro" },
      h("p", null, open.length ? `${open.length} open across the manuscript. Each cites the passages involved; nothing changes until you click.` : "No open issues. The checks run whenever you pause."),
      s &&
        h(
          "button",
          { onclick: () => deepCheck(s), disabled: state.aiBusy.has(s.id), title: aiOn ? "Ask the AI tier for subtler problems in this scene" : "Turn on the AI tier in Settings" },
          state.aiBusy.has(s.id) ? "Checking…" : `AI check: “${s.title}”`,
        ),
    ),
    SEV_ORDER.map((sev) => {
      const list = open.filter((i) => i.severity === sev);
      return list.length ? h("section", null, h("h2", { class: "group" }, `${sev[0].toUpperCase() + sev.slice(1)} (${list.length})`), list.map(issueCard)) : null;
    }),
    decided.length
      ? h(
          "section",
          null,
          h("button", { class: "linkish", onclick: () => ((state.showDecided = !state.showDecided), renderPanel()) }, `${state.showDecided ? "Hide" : "Show"} ${decided.length} marked intentional or dismissed`),
          state.showDecided ? decided.map(issueCard) : null,
        )
      : null,
  );
}

function renderBible(el: HTMLElement) {
  const scenes = scenesInOrder();
  const pres = presence(state.model, scenes);
  const q = state.bibleQuery.toLowerCase();
  const list = state.model.entities
    .filter((e) => (state.bibleKind === "all" || e.kind === state.bibleKind) && (!q || [e.name, ...e.aliases].some((n) => n.toLowerCase().includes(q))))
    .sort((a, b) => (pres.get(b.id)?.size ?? 0) - (pres.get(a.id)?.size ?? 0));
  const characters = state.model.entities.filter((e) => e.kind === "character");
  clear(
    el,
    h(
      "div",
      { class: "panel-intro" },
      h("p", null, "Built from your draft. Your edits here always win: pin a fact to make it canon, merge duplicates, or remove things that aren't entities."),
      h(
        "div",
        { class: "filters" },
        h("input", {
          type: "search",
          placeholder: "Find…",
          value: state.bibleQuery,
          oninput: (e: Event) => {
            state.bibleQuery = (e.target as HTMLInputElement).value;
            renderPanel();
            ($("panel-body").querySelector("input[type=search]") as HTMLInputElement)?.focus();
          },
        }),
        h(
          "select",
          { onchange: (e: Event) => ((state.bibleKind = (e.target as HTMLSelectElement).value as EntityKind | "all"), renderPanel()) },
          (["all", "character", "place", "object"] as const).map((k) => h("option", { value: k, selected: state.bibleKind === k }, k === "all" ? "Everything" : k[0].toUpperCase() + k.slice(1) + "s")),
        ),
      ),
    ),
    list.length ? list.map((e) => entityCard(e, pres.get(e.id), scenes, characters)) : h("p", { class: "muted" }, "Nothing yet. Names appear here as you write them."),
  );
}

function entityCard(e: Entity, seen: Set<number> | undefined, scenes: Scene[], characters: Entity[]) {
  const facts = state.model.facts.filter((f) => f.entityId === e.id);
  const first = seen?.size ? scenes[Math.min(...seen)] : undefined;
  const firstMention = first && state.model.mentions.find((m) => m.entityId === e.id && m.span.sceneId === first.id);
  const bible = state.project.bible;
  return h(
    "article",
    { class: "card entity" },
    h(
      "header",
      null,
      h("input", {
        class: "entity-name",
        value: e.name,
        "aria-label": "Name",
        onchange: (ev: Event) => {
          const v = (ev.target as HTMLInputElement).value.trim();
          if (v && v !== e.name) {
            bible.renames[e.id] = v;
            bibleChanged();
          }
        },
      }),
      h(
        "select",
        { class: "kind", onchange: (ev: Event) => ((bible.kinds[e.id] = (ev.target as HTMLSelectElement).value as EntityKind), bibleChanged()) },
        (["character", "place", "object"] as const).map((k) => h("option", { value: k, selected: e.kind === k }, k)),
      ),
    ),
    e.aliases.length ? h("div", { class: "aliases" }, "Also: ", e.aliases.join(", ")) : null,
    h(
      "div",
      { class: "muted small" },
      seen?.size ? `In ${seen.size} scene${seen.size > 1 ? "s" : ""}, first in ` : "Not seen in the text",
      firstMention ? h("button", { class: "linkish", onclick: () => jump(firstMention.span) }, `ch. ${first!.chapter}`) : null,
    ),
    facts.length
      ? h(
          "table",
          { class: "facts" },
          facts.map((f) => {
            const pinned = f.status === "pinned";
            const sc = sceneOf(f.span);
            return h(
              "tr",
              { class: pinned ? "pinned" : "" },
              h("td", { class: "attr" }, f.attribute),
              h("td", { class: "val" }, f.value),
              h("td", null, h("button", { class: "linkish", title: f.span.quote, onclick: () => jump(f.span) }, sc ? `ch. ${sc.chapter}` : "?")),
              h("td", { class: "src muted small", title: f.source === "ai" ? "Found by the AI tier" : "Found by the local rules" }, f.source === "ai" ? "AI" : "rule"),
              h(
                "td",
                null,
                h(
                  "button",
                  {
                    class: "pin" + (pinned ? " on" : ""),
                    title: pinned ? "Canon. Click to unpin." : "Pin as canon: the rest of the book is checked against it",
                    onclick: () => {
                      const k = factKey(f);
                      bible.pinned = pinned ? bible.pinned.filter((x) => x !== k) : [...bible.pinned.filter((x) => !x.startsWith(`${f.entityId}|${f.attribute}|`)), k];
                      bibleChanged();
                    },
                  },
                  pinned ? "Canon" : "Pin",
                ),
              ),
            );
          }),
        )
      : null,
    h(
      "div",
      { class: "actions" },
      e.kind === "character" && characters.length > 1
        ? h(
            "select",
            {
              onchange: (ev: Event) => {
                const target = (ev.target as HTMLSelectElement).value;
                if (!target) return;
                bible.merges[e.name] = target;
                bibleChanged();
                toast(`Merged ${e.name} into ${target}.`, { label: "Undo", run: () => (delete bible.merges[e.name], bibleChanged()) });
              },
            },
            h("option", { value: "" }, "Same person as…"),
            characters.filter((c) => c.id !== e.id).map((c) => h("option", { value: c.name }, c.name)),
          )
        : null,
      h(
        "button",
        {
          onclick: () => {
            bible.notEntities.push(e.name);
            bibleChanged();
            toast(`Removed "${e.name}" from the bible.`, { label: "Undo", run: () => ((bible.notEntities = bible.notEntities.filter((n) => n !== e.name)), bibleChanged()) });
          },
        },
        "Not an entity",
      ),
    ),
  );
}

function renderTracking(el: HTMLElement) {
  const scenes = scenesInOrder();
  const pres = presence(state.model, scenes);
  const acting = new Set(state.model.mentions.filter((m) => m.acting).map((m) => `${m.entityId}@${m.span.sceneId}`));
  const cast = state.model.entities
    .filter((e) => e.kind === "character" && (pres.get(e.id)?.size ?? 0) >= 1)
    .sort((a, b) => (pres.get(b.id)?.size ?? 0) - (pres.get(a.id)?.size ?? 0))
    .slice(0, 20);
  const head = h("tr", null, h("th"), scenes.map((s) => h("th", { title: `Ch. ${s.chapter}: ${s.title}`, class: s.id === state.activeId ? "cur" : "" }, s.chapter)));
  const grid = (rows: HTMLElement[]) => h("div", { class: "grid-wrap" }, h("table", { class: "grid" }, head.cloneNode(true), rows));

  const themeNames = Object.keys(state.model.themes);
  const maxTheme = Math.max(1, ...themeNames.flatMap((t) => Object.values(state.model.themes[t])));
  const order = new Map(scenes.map((s, i) => [s.id, i]));

  const dated = scenes.filter((s) => s.date).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));

  clear(
    el,
    h("h2", { class: "group" }, "Who appears where"),
    h("p", { class: "muted small" }, "Dark: acts in the scene. Light: mentioned. Click a cell to open the scene."),
    grid(
      cast.map((e) =>
        h(
          "tr",
          null,
          h("th", { class: "rowh" }, e.name),
          scenes.map((s, i) => {
            const here = pres.get(e.id)?.has(i);
            const acts = acting.has(`${e.id}@${s.id}`);
            return h("td", {
              class: here ? (acts ? "on acts" : "on") : "",
              title: `${e.name} · ch. ${s.chapter} ${s.title}`,
              onclick: () => {
                const m = state.model.mentions.find((x) => x.entityId === e.id && x.span.sceneId === s.id);
                if (m) jump(m.span);
                else selectScene(s.id);
              },
            });
          }),
        ),
      ),
    ),
    h("h2", { class: "group" }, "Themes and motifs"),
    h("p", { class: "muted small" }, "How often each theme's words recur in each scene."),
    grid(
      themeNames.map((t) =>
        h(
          "tr",
          null,
          h("th", { class: "rowh" }, t),
          scenes.map((s) => {
            const n = state.model.themes[t][s.id] ?? 0;
            return h("td", { class: n ? "heat" : "", style: n ? `--a:${(0.25 + (0.75 * n) / maxTheme).toFixed(2)}` : undefined, title: `${t}: ${n} in ch. ${s.chapter}`, onclick: () => selectScene(s.id) });
          }),
        ),
      ),
    ),
    h("h2", { class: "group" }, "Plot threads"),
    state.model.threads.length
      ? grid(
          state.model.threads.map((t) => {
            const resolved = t.beats.some((b) => b.kind === "resolve");
            return h(
              "tr",
              null,
              h("th", { class: "rowh", title: resolved ? "Resolved" : "Open" }, `${resolved ? "✓" : "○"} ${t.label}`),
              scenes.map((s) => {
                const beats = t.beats.filter((b) => b.span.sceneId === s.id);
                const kind = beats.find((b) => b.kind === "resolve") ? "resolve" : beats.find((b) => b.kind === "open") ? "open" : beats.length ? "advance" : "";
                return h("td", { class: kind ? `beat ${kind}` : "", title: kind ? `${kind} in ch. ${s.chapter}` : "", onclick: () => (beats[0] ? jump(beats[0].span) : selectScene(s.id)) }, kind === "resolve" ? "✓" : kind === "open" ? "●" : kind ? "•" : "");
              }),
            );
          }),
        )
      : h("p", { class: "muted small" }, "No threads found yet. Introduce a mystery (“the unsigned letter”, “the missing key”) and it will be tracked until it's resolved."),
    h("h2", { class: "group" }, "Timeline"),
    dated.length
      ? h(
          "ol",
          { class: "timeline" },
          dated.map((s) => {
            const who = [...new Set(state.model.mentions.filter((m) => m.span.sceneId === s.id && m.acting).map((m) => m.entityId))]
              .map((id) => state.model.entities.find((e) => e.id === id)?.name)
              .filter(Boolean);
            const outOfOrder = order.get(s.id)! < Math.max(...dated.filter((d) => d.date! < s.date!).map((d) => order.get(d.id)!), -1);
            return h(
              "li",
              { onclick: () => selectScene(s.id) },
              h("span", { class: "date" }, s.date),
              h("span", null, h("strong", null, `Ch. ${s.chapter} · ${s.title}`), s.location ? ` · ${s.location}` : "", outOfOrder ? h("span", { class: "tag" }, "told out of order") : null),
              h("span", { class: "muted small" }, who.join(", ")),
            );
          }),
        )
      : h("p", { class: "muted small" }, "Give scenes an in-story date (the “When” field) to see them on a timeline and to check travel and ages."),
  );
  void yearOf;
}

function renderSettings(el: HTMLElement) {
  const st = state.project.settings;
  const bible = state.project.bible;
  const allTypes = Object.keys(TYPE_LABEL).filter((t) => t !== "ai") as IssueType[];
  const edits: [string, () => void][] = [
    ...Object.entries(bible.merges).map(([a, b]) => [`${a} is the same as ${b}`, () => delete bible.merges[a]] as [string, () => void]),
    ...bible.notEntities.map((n) => [`"${n}" is not an entity`, () => (bible.notEntities = bible.notEntities.filter((x) => x !== n))] as [string, () => void]),
    ...Object.entries(bible.renames).map(([id, n]) => [`Renamed ${id.slice(2)} to ${n}`, () => delete bible.renames[id]] as [string, () => void]),
    ...bible.pinned.map((k) => [`Canon: ${k.split("|").slice(1).join(" = ")} (${k.split("|")[0].slice(2)})`, () => (bible.pinned = bible.pinned.filter((x) => x !== k))] as [string, () => void]),
  ];
  clear(
    el,
    h("h2", { class: "group" }, "Checks"),
    h(
      "label",
      { class: "row" },
      h("span", null, "Flag a recurring character missing for more than"),
      h("input", {
        type: "number",
        min: 10,
        max: 90,
        step: 5,
        value: Math.round(st.absenceShare * 100),
        onchange: (e: Event) => ((st.absenceShare = Math.min(0.9, Math.max(0.1, parseInt((e.target as HTMLInputElement).value, 10) / 100))), analyse(), scheduleSave()),
      }),
      h("span", null, "% of scenes"),
    ),
    allTypes.map((t) =>
      h(
        "label",
        { class: "row" },
        h("input", {
          type: "checkbox",
          checked: !st.disabledTypes.includes(t),
          onchange: (e: Event) => {
            st.disabledTypes = (e.target as HTMLInputElement).checked ? st.disabledTypes.filter((x) => x !== t) : [...st.disabledTypes, t];
            analyse();
            scheduleSave();
          },
        }),
        TYPE_LABEL[t],
      ),
    ),
    h("h2", { class: "group" }, "AI tier"),
    h(
      "p",
      { class: "muted small" },
      "Rule checks run locally and need no network. The AI tier adds deeper reading: richer facts, plot threads, and per-scene checks for knowledge leaks, POV slips and setting drift. In this prototype it calls Claude with your own API key, standing in for Chaptr's endpoints. Only the scene being read is sent, and every request is logged below.",
    ),
    h(
      "label",
      { class: "row" },
      h("input", { type: "checkbox", checked: st.aiEnabled, onchange: (e: Event) => ((st.aiEnabled = (e.target as HTMLInputElement).checked), scheduleSave(), renderPanel(), maybeExtractWithAI()) }),
      "Use the AI tier for this project",
    ),
    h(
      "label",
      { class: "row" },
      h("span", null, "Anthropic API key"),
      h("input", {
        type: "password",
        placeholder: "sk-ant-…",
        value: getPref("api-key") ?? "",
        autocomplete: "off",
        onchange: (e: Event) => (setPref("api-key", (e.target as HTMLInputElement).value.trim()), maybeExtractWithAI()),
      }),
    ),
    h("p", { class: "muted small" }, "The key is kept on this computer only, never in the project folder."),
    h("div", { class: "actions" }, h("button", { onclick: extractAll, disabled: !st.aiEnabled }, "Read the whole manuscript with AI")),
    state.log.length
      ? h(
          "table",
          { class: "log" },
          h("tr", null, h("th", null, "When"), h("th", null, "Call"), h("th", null, "Scene"), h("th", null, "Sent"), h("th", null, "")),
          state.log.slice(0, 30).map((l) =>
            h("tr", null, h("td", null, new Date(l.at).toLocaleTimeString()), h("td", null, l.endpoint), h("td", null, l.scene), h("td", null, `${l.chars.toLocaleString()} chars`), h("td", { title: l.note ?? "" }, l.ok ? "ok" : "failed")),
          ),
        )
      : h("p", { class: "muted small" }, "Nothing sent yet."),
    h("h2", { class: "group" }, "Your bible edits"),
    edits.length
      ? h("ul", { class: "edits" }, edits.map(([label, undo]) => h("li", null, label, h("button", { class: "linkish", onclick: () => (undo(), bibleChanged()) }, "Undo"))))
      : h("p", { class: "muted small" }, "None yet."),
    h("h2", { class: "group" }, "Project"),
    h("p", { class: "muted small" }, store.where()),
    h(
      "div",
      { class: "actions wrap" },
      h("button", { onclick: importFile }, "Import .docx, .txt or .md…"),
      h(
        "button",
        {
          onclick: async () => {
            const text = exportMarkdown(state.project, scenesInOrder());
            if (store.exportMarkdown) toast(`Exported to ${await store.exportMarkdown(state.project, text)}`);
            else download(`${state.project.title}.md`, text);
          },
        },
        "Export Markdown",
      ),
      h("button", { onclick: () => setLibrary(true) }, "All novels…"),
    ),
  );
}

// ---------- wiring

$("mode").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest("button")?.dataset.mode as FlagMode | undefined;
  if (m) setMode(m);
});
$("tabs").addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("button")?.dataset.tab as Tab | undefined;
  if (!t) return;
  state.tab = t;
  renderLayout();
  renderPanel();
});
$("toggle-panel").addEventListener("click", () => {
  state.panelOpen = !state.panelOpen;
  renderLayout();
});
$("toggle-binder").addEventListener("click", () => {
  state.binderOpen = !state.binderOpen;
  renderLayout();
});
$("badge").addEventListener("click", () => {
  state.tab = "issues";
  state.panelOpen = true;
  renderLayout();
  renderPanel();
});
$("focus").addEventListener("click", () => setFocus(!state.focus));
$("open-library").addEventListener("click", () => setLibrary(!state.libraryOpen));
$("project-title").addEventListener("input", (e) => {
  state.project.title = (e.target as HTMLInputElement).value;
  scheduleSave();
});

function setFocus(on: boolean) {
  state.focus = on;
  editor.setTypewriter(on);
  renderLayout();
  editor.focus();
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape" && state.libraryOpen && !state.renaming) setLibrary(false);
  else if (e.key === "Escape" && state.focus) setFocus(false);
  else if (mod && e.key === "s") {
    e.preventDefault();
    saveNow();
  } else if (mod && e.key === ".") {
    e.preventDefault();
    state.panelOpen = !state.panelOpen;
    renderLayout();
  }
});

async function boot() {
  // Reopen the novel last worked on, else the most recently saved one, else the sample.
  let saved: Project | null = null;
  try {
    const list = await store.list();
    const pick = list.find((x) => x.id === getPref("last-project")) ?? list[0];
    if (pick) saved = await store.load(pick.id);
  } catch {
    /* no library yet */
  }
  loadProject(saved ?? sampleProject());
  state.saveText = saved ? (store.kind === "folder" ? "Saved" : "Saved in this browser") : "";
  $("save-status").textContent = state.saveText;
  if (!saved) toast("This is a sample manuscript with planted continuity errors. Try the Issues panel, or start your own from the Library.");
  if (isDesktop()) document.documentElement.classList.add("desktop");
}

boot();
