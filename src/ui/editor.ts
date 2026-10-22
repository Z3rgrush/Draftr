import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { fnv1a } from "../core/text";
import type { Severity, Span } from "../core/types";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    text: {},
  },
});

export interface Underline {
  span: Span;
  severity: Severity;
  key: string;
}

const marksKey = new PluginKey<DecorationSet>("issues");

function docFromText(text: string): PMNode {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " "));
  return schema.node(
    "doc",
    null,
    (paras.length ? paras : [""]).map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : [])),
  );
}

function textFromDoc(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.textContent));
  return out.join("\n\n");
}

/** Map a span (paragraph hash + offsets) to document positions, using the same hashing as segment(). */
function resolveSpan(doc: PMNode, span: Span): { from: number; to: number } | null {
  const seen = new Map<string, number>();
  let found: { from: number; to: number } | null = null;
  doc.forEach((node, offset) => {
    if (found) return;
    const raw = node.textContent;
    const text = raw.trim();
    if (!text) return;
    const base = fnv1a(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const hash = n ? `${base}-${n}` : base;
    const lead = raw.length - raw.trimStart().length;
    if (hash === span.paraHash && text.slice(span.start, span.end) === span.quote) {
      found = { from: offset + 1 + lead + span.start, to: offset + 1 + lead + span.end };
    }
  });
  if (found) return found;
  // Paragraph changed since analysis: fall back to the quote.
  doc.forEach((node, offset) => {
    if (found) return;
    const i = node.textContent.indexOf(span.quote);
    if (i >= 0) found = { from: offset + 1 + i, to: offset + 1 + i + span.quote.length };
  });
  return found;
}

export class ManuscriptEditor {
  view: EditorView;
  private typewriter = false;

  constructor(
    mount: HTMLElement,
    private onChange: (text: string) => void,
    private onIssueClick: (key: string) => void,
  ) {
    this.view = new EditorView(mount, {
      state: this.makeState(""),
      attributes: { class: "manuscript", spellcheck: "true" },
      dispatchTransaction: (tr) => {
        const state = this.view.state.apply(tr);
        this.view.updateState(state);
        if (tr.docChanged) this.onChange(textFromDoc(state.doc));
        if (this.typewriter && (tr.docChanged || tr.selectionSet)) this.centerCursor();
      },
      handleClick: (_view, _pos, event) => {
        const el = (event.target as HTMLElement).closest("[data-issue]");
        if (el) this.onIssueClick(el.getAttribute("data-issue")!);
        return false;
      },
    });
  }

  private makeState(text: string) {
    return EditorState.create({
      doc: docFromText(text),
      plugins: [
        history(),
        keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
        keymap(baseKeymap),
        new Plugin<DecorationSet>({
          key: marksKey,
          state: {
            init: () => DecorationSet.empty,
            apply: (tr, set) => {
              const meta = tr.getMeta(marksKey) as DecorationSet | undefined;
              return meta ?? set.map(tr.mapping, tr.doc);
            },
          },
          props: { decorations: (s) => marksKey.getState(s) },
        }),
      ],
    });
  }

  load(text: string) {
    this.view.updateState(this.makeState(text));
  }

  get text() {
    return textFromDoc(this.view.state.doc);
  }

  setUnderlines(list: Underline[], flash?: Span) {
    const doc = this.view.state.doc;
    const decos: Decoration[] = [];
    for (const u of list) {
      const r = resolveSpan(doc, u.span);
      if (r && r.to > r.from) decos.push(Decoration.inline(r.from, r.to, { class: `flag flag-${u.severity}`, "data-issue": u.key }));
    }
    if (flash) {
      const r = resolveSpan(doc, flash);
      if (r) decos.push(Decoration.inline(r.from, r.to, { class: "flash" }));
    }
    this.view.dispatch(this.view.state.tr.setMeta(marksKey, DecorationSet.create(doc, decos)).setMeta("addToHistory", false));
  }

  /** Select a passage and bring it to the middle of the screen. */
  reveal(span: Span) {
    const r = resolveSpan(this.view.state.doc, span);
    if (!r) return false;
    const tr = this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, r.from, r.to));
    this.view.dispatch(tr);
    this.view.focus();
    requestAnimationFrame(() => this.centerCursor());
    return true;
  }

  setTypewriter(on: boolean) {
    this.typewriter = on;
    if (on) this.centerCursor();
  }

  focus() {
    this.view.focus();
  }

  private centerCursor() {
    const { from } = this.view.state.selection;
    let coords: { top: number };
    try {
      coords = this.view.coordsAtPos(from);
    } catch {
      return;
    }
    const scroller = this.view.dom.closest(".editor-scroll") as HTMLElement | null;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += coords.top - (box.top + box.height / 2);
  }
}
