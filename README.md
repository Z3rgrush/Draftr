# Draftr: drafting prototype

A first prototype of the desktop novel-drafting app described in the Drafting App Design Doc. It covers the core loop: the author writes freely, the app builds a story bible (characters, places, facts, plot threads, themes) from the draft on its own, and it flags contradictions with the passages involved and one-click fixes.

It opens on a 10-scene sample, *The Ashgrove Letters*, with seven planted continuity errors so there is something to find straight away.

## What works

| Area | In the prototype |
|---|---|
| Editor | ProseMirror editor, binder of chapters and scenes, per-scene title, POV, location, in-story date and status, focus mode with typewriter scrolling, autosave, word counts |
| Story bible | Built automatically: characters and places with aliases (including nicknames such as Liz for Elizabeth and titles such as Inspector Hale), facts with the sentence each came from. Pin a fact as canon, rename, change kind, merge duplicates, mark "not an entity". The author's edits always win and can be undone from Settings |
| Checks | Attribute contradictions (eye and hair colour), ages that disagree with a birth year or each other given scene dates, a dead character who acts later, name drift (Marcus/Markus), one character in two places on the same day, plot threads never resolved, recurring characters who vanish for a long stretch |
| Issues | Grouped by severity, each citing the passages in conflict (click to jump). Suggested fixes show as a diff and apply only on click, with undo. Intentional and Dismiss are remembered per issue across edits |
| Author control | Quiet (nothing shown), Gentle (a count only) and Editor (underlines plus the panel) modes, per-check toggles, absence threshold |
| Tracking | Who appears where (acting vs mentioned), theme strip, plot-thread beats, timeline by in-story date |
| AI tier | A narrow `StoryAI` interface shaped like the proposed Chaptr API (`extract`, `check`). Until Chaptr's endpoints exist, `ClaudeStandIn` implements it on the Claude API with the author's own key: per-scene extraction on a long pause, an on-demand deep check per scene (knowledge leaks, POV slips, setting drift), and a send log. AI facts are dropped automatically when the paragraph they came from changes. Off by default; rule checks need no network |
| Files | Each project is a plain folder: `project.json` plus one Markdown-with-frontmatter file per scene in `scenes/`. Writes are atomic, unchanged files are not rewritten, and deleted scenes go to `.trash/`. Import `.txt`/`.md` by chapter headings and scene breaks; export Markdown |

## Stack and why

**Tauri 2 (Rust shell) with a TypeScript and ProseMirror UI**, as the design doc recommends. Tauri gives small installers and low memory for long manuscripts, and ProseMirror is the most capable web editor for book-length text with decorations (the underlines). Electron stays the fallback if WebView differences between macOS and Windows hurt the editor.

One deliberate change from the doc for this stage: the story model and checks are written in TypeScript (`src/core`), not Rust. That keeps the core loop in one language while it is still changing fast, lets the same code run in a browser preview for quick feedback, and keeps the test suite simple. Rust currently owns the project files. Moving indexing into the Rust core is a later step once the model settles; `src/core` has no DOM dependencies, so it can move to a worker or be ported.

## Run it

```bash
npm install
npm test               # core tests (vitest)
npm run tauri dev      # desktop app (needs Rust and the Tauri prerequisites for your OS)
npm run tauri build    # installers for the current OS
npm run build:preview  # single-file browser preview in dist-preview/
cd src-tauri && cargo test   # Rust file-handling tests
```

Projects are saved under `Documents/Draftr/<title>-<id>/`.

To try the AI tier: Settings, turn on "Use the AI tier", paste an Anthropic API key. The key stays on the machine and is never written to the project folder.

## Measured

- All seven planted errors in the sample are found, with no false flags on it (`tests/core.test.ts`).
- A full re-analysis of a 150,000-word manuscript takes about 0.65 s on the build machine, and a 10-scene draft about 5 ms. It runs after a 1.5 s pause in typing, never per keystroke. The design doc's target is 200 ms per incremental check; per-paragraph caching (the next step) gets there because most of the work is re-reading unchanged paragraphs.

## Known limits

- The local extractor is rule-based English. It recognises common phrasings ("her green eyes", "Hale was thirty-four years old", "Reed was dead") and will miss others; that gap is what the AI tier is for. Pronoun resolution uses a simple vote per character.
- Plot threads are detected locally only when a mystery is introduced as "the missing key", "the unsigned letter" and so on. The AI tier finds the rest.
- No rich text yet (italics, scene-break styles), no .docx or Scrivener import, no version snapshots, no relationship map, no "Ask the manuscript".
- The AI tier calls the Claude API directly from the app with the author's key. A production build would route through the Chaptr client in the Rust core with Chaptr's no-training and no-retention terms.

## Layout

```
src/core/      story model, extraction, checks, edits, project files, AI interface (no DOM)
src/ui/        ProseMirror editor wrapper and a tiny DOM helper
src/main.ts    the app: binder, editor, issues, bible, tracking, settings
src/data/      the sample manuscript
src-tauri/     Rust shell: project folder read/write, export
tests/         vitest suite
```
