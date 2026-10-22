import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { importDocx, readDocx } from "../src/core/docx";
import { buildModel } from "../src/core/model";
import { runChecks } from "../src/core/checks";
import { sampleProject } from "../src/data/sample";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (body: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${body}</w:p>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Kapitel"><w:name w:val="Kapitel"/><w:basedOn w:val="Heading1"/></w:style>
  <w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

function docx(body: string, styles = STYLES): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(doc), "word/styles.xml": strToU8(styles) });
}

describe("docx import", () => {
  it("splits chapters by Heading 1 and scenes by Heading 2 and scene breaks", () => {
    const bytes = docx(
      [
        para(run("The Ashgrove Letters"), "Title"),
        para(run("Chapter One: Arrival"), "Heading1"),
        para(run("It began.")),
        para(run("* * *")),
        para(run("Then more.")),
        para(run("Chapter 2"), "Heading1"),
        para(run("The Pier"), "Heading2"),
        para(run("Fin.")),
        para(run("The Return"), "Heading2"),
        para(run("Again.")),
      ].join(""),
    );
    const { project, chapters, splitBy } = importDocx(bytes, "fallback");
    expect(project.title).toBe("The Ashgrove Letters");
    expect(splitBy).toBe("headings");
    expect(chapters).toBe(2);
    expect(project.scenes.map((s) => [s.chapter, s.title, s.text])).toEqual([
      [1, "Arrival", "It began."],
      [1, "Scene 2", "Then more."],
      [2, "The Pier", "Fin."],
      [2, "The Return", "Again."],
    ]);
  });

  it("keeps italic and bold as markers, and drops deleted and hidden text", () => {
    const bytes = docx(
      para(
        run("She read ") +
          run("The Times ", "<w:i/>") +
          run("and ") +
          `<w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>wept</w:t></w:r>` +
          run(". ") +
          run("Never", "<w:b/>") +
          run(" again", '<w:b w:val="0"/>') +
          `<w:del w:id="1"><w:r><w:delText>deleted words</w:delText></w:r></w:del>` +
          run(" secret", "<w:vanish/>") +
          run(" & done."),
      ),
    );
    expect(readDocx(bytes)[0].text).toBe("She read *The Times* and *wept*. **Never** again & done.");
  });

  it("follows custom heading styles based on Heading 1, and skips Part headings", () => {
    const bytes = docx(
      [
        para(run("Part One"), "Heading1"),
        para(run("Eins"), "Heading2"),
        para(run("Erster Absatz.")),
        para(run("Part Two"), "Heading1"),
        para(run("Zwei"), "Heading2"),
        para(run("Zweiter Absatz.")),
      ].join(""),
    );
    const { project } = importDocx(bytes, "Buch");
    expect(project.title).toBe("Buch");
    expect(project.scenes.map((s) => [s.chapter, s.title])).toEqual([
      [1, "Eins"],
      [2, "Zwei"],
    ]);
    const custom = importDocx(docx(para(run("Der Anfang"), "Kapitel") + para(run("Text."))), "x");
    expect(custom.splitBy).toBe("headings");
    expect(custom.project.scenes[0].title).toBe("Der Anfang");
  });

  it("falls back to 'Chapter' lines in manuscripts without heading styles", () => {
    const bytes = docx([para(run("CHAPTER ONE", "<w:b/>")), para(run("First.")), para(run("#")), para(run("Second.")), para(run("Chapter Two")), para(run("Third."))].join(""));
    const { project, splitBy } = importDocx(bytes, "Manuscript");
    expect(splitBy).toBe("chapter-lines");
    expect(project.scenes.map((s) => [s.chapter, s.text])).toEqual([
      [1, "First."],
      [1, "Second."],
      [2, "Third."],
    ]);
  });

  it("explains when the file is not a .docx", () => {
    expect(() => readDocx(strToU8("plain text"))).toThrow(/isn't a Word \.docx/);
  });

  it("finds the same continuity problems in an imported Word manuscript", () => {
    const sample = sampleProject();
    let ch = 0;
    const body = sample.scenes
      .map((s) => {
        const head = s.chapter !== ch ? para(run(`Chapter ${(ch = s.chapter)}`), "Heading1") : para(run("* * *"));
        return head + s.text.split(/\n\s*\n/).map((t) => para(run(t))).join("");
      })
      .join("");
    const { project } = importDocx(docx(body), sample.title);
    expect(project.scenes.map((s) => s.text)).toEqual(sample.scenes.map((s) => s.text.split(/\n\s*\n/).map((t) => t.trim()).join("\n\n")));
    const found = new Set(runChecks(project, buildModel(project)).map((i) => i.type));
    for (const t of ["attribute", "dead-returns", "name-drift", "open-thread"] as const) expect(found).toContain(t);
  });
});
