import { describe, expect, it } from "vitest";
import { sampleProject } from "../src/data/sample";
import { buildModel, factKey } from "../src/core/model";
import { runChecks } from "../src/core/checks";
import { applySuggestion, restoreScenes } from "../src/core/edits";
import { fromFiles, importManuscript, newProject, toFiles } from "../src/core/project";
import type { Project } from "../src/core/types";

const analyse = (p: Project) => runChecks(p, buildModel(p));
const types = (p: Project) => analyse(p).map((i) => i.type).sort();

function oneScene(text: string, extra: Partial<Project["scenes"][0]> = {}): Project {
  const p = newProject("t");
  p.scenes = [{ id: "a", title: "A", chapter: 1, text, ...extra }];
  return p;
}

describe("sample manuscript", () => {
  it("finds every planted problem and nothing else", () => {
    expect(types(sampleProject())).toEqual(["absence", "age", "attribute", "dead-returns", "name-drift", "open-thread", "timeline"]);
  });

  it("builds the cast with aliases and nicknames", () => {
    const m = buildModel(sampleProject());
    const hale = m.entities.find((e) => e.name === "Elizabeth Hale")!;
    expect(hale.aliases).toEqual(expect.arrayContaining(["Hale", "Liz"]));
    expect(m.entities.find((e) => e.name === "Lisbon")?.kind).toBe("place");
  });

  it("every issue cites passages that exist in the text", () => {
    const p = sampleProject();
    for (const i of analyse(p)) {
      const all = [...i.spans, ...(i.context ?? [])];
      expect(all.length).toBeGreaterThan(0);
      for (const s of all) expect(p.scenes.find((x) => x.id === s.sceneId)!.text).toContain(s.quote);
    }
  });

  it("applying a suggestion fixes the issue, and undo restores the text", () => {
    const p = sampleProject();
    const issue = analyse(p).find((i) => i.type === "attribute")!;
    const green = issue.suggestions.find((s) => s.label.includes("green"))!;
    const { before, applied } = applySuggestion(p, green);
    expect(applied).toBe(1);
    expect(p.scenes.find((s) => s.id === "s6")!.text).toContain("her green eyes");
    expect(analyse(p).some((i) => i.type === "attribute")).toBe(false);
    restoreScenes(p, before);
    expect(p.scenes.find((s) => s.id === "s6")!.text).toContain("her brown eyes");
  });

  it("age fix writes the number the way the author wrote it", () => {
    const p = sampleProject();
    const issue = analyse(p).find((i) => i.type === "age")!;
    applySuggestion(p, issue.suggestions[0]);
    expect(p.scenes.find((s) => s.id === "s2")!.text).toContain("Hale was thirty-eight years old");
    expect(analyse(p).some((i) => i.type === "age")).toBe(false);
  });

  it("name drift and timeline fixes clear their issues", () => {
    const p = sampleProject();
    for (const t of ["name-drift", "timeline"]) {
      const issue = analyse(p).find((i) => i.type === t)!;
      applySuggestion(p, issue.suggestions[0]);
    }
    expect(types(p)).not.toContain("name-drift");
    expect(types(p)).not.toContain("timeline");
    expect(p.scenes.find((s) => s.id === "s6")!.date).toBe("1998-03-06");
  });

  it("a pinned fact becomes the reference", () => {
    const p = sampleProject();
    const m = buildModel(p);
    const brown = m.facts.find((f) => f.attribute === "eyes" && f.value === "brown")!;
    p.bible.pinned.push(factKey(brown));
    const issue = analyse(p).find((i) => i.type === "attribute")!;
    expect(issue.suggestions.map((s) => s.label)).toEqual(["Make it brown everywhere (1 edit)"]);
    expect(issue.explanation).toContain("pins");
  });

  it("issue keys are stable across unrelated edits", () => {
    const p = sampleProject();
    const before = analyse(p).map((i) => i.key).sort();
    p.scenes[2].text += "\n\nThe kettle clicked off.";
    expect(analyse(p).map((i) => i.key).sort()).toEqual(before);
  });

  it("bible edits win: not-an-entity and merges", () => {
    const p = sampleProject();
    p.bible.notEntities.push("Gazette");
    p.bible.merges["Markus Ortiz"] = "Marcus Ortiz";
    const m = buildModel(p);
    expect(m.entities.some((e) => e.name === "Gazette")).toBe(false);
    expect(m.entities.find((e) => e.name === "Marcus Ortiz")!.aliases).toContain("Markus Ortiz");
    expect(runChecks(p, m).some((i) => i.type === "name-drift")).toBe(false);
  });
});

describe("extraction", () => {
  it("resolves her/his to the right character", () => {
    const p = oneScene(
      `Anna Webb met Tom Carver at the gate. Anna Webb smiled at her own reflection. Tom Carver rubbed his jaw. He had not slept.\n\nTom Carver looked into her grey eyes and said nothing.`,
    );
    const f = buildModel(p).facts.find((x) => x.attribute === "eyes")!;
    expect(f.entityId).toBe("e:anna-webb");
    expect(f.value).toBe("grey");
  });

  it("does not flag clean prose", () => {
    const p = oneScene(
      `Anna Webb had green eyes and a habit of counting stairs. She was thirty years old.\n\nLater, Anna Webb looked at the sea with those same green eyes.`,
      { date: "2001-05-01" },
    );
    expect(analyse(p)).toEqual([]);
  });

  it("ignores conditional deaths", () => {
    const p = oneScene(`If Tom Carver died, nobody would mourn. Tom Carver said nothing.`);
    expect(buildModel(p).facts.filter((f) => f.attribute === "status")).toEqual([]);
  });
});

describe("project files", () => {
  it("round-trips through the folder format", () => {
    const p = sampleProject();
    const back = fromFiles(JSON.parse(JSON.stringify(toFiles(p))));
    expect(back.scenes).toEqual(p.scenes);
    expect(back.title).toBe(p.title);
  });

  it("imports a manuscript by chapter headings and scene breaks", () => {
    const p = importManuscript(`# Chapter One\nIt began.\n\n* * *\n\nThen more.\n\nChapter 2: The End\nFin.`, "Book");
    expect(p.scenes.map((s) => [s.chapter, s.text])).toEqual([
      [1, "It began."],
      [1, "Then more."],
      [2, "Fin."],
    ]);
  });
});

describe("performance", () => {
  it("analyses a 150,000-word manuscript quickly enough to run on pause", () => {
    const base = sampleProject();
    const p = newProject("big");
    p.scenes = [];
    let words = 0;
    for (let i = 0; words < 150_000; i++) {
      const s = base.scenes[i % base.scenes.length];
      p.scenes.push({ ...s, id: `x${i}`, chapter: i + 1, text: s.text + `\n\nScene marker ${i}.` });
      words += s.text.split(/\s+/).length + 3;
    }
    const t0 = performance.now();
    runChecks(p, buildModel(p));
    const ms = performance.now() - t0;
    console.log(`150k words, ${p.scenes.length} scenes: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});

describe("AI tier results", () => {
  it("merge into the model and are dropped once their paragraph changes", async () => {
    const { segment } = await import("../src/core/text");
    const p = sampleProject();
    const s1 = p.scenes[0];
    const para = segment(s1)[4];
    const span = { sceneId: s1.id, paraHash: para.hash, start: 0, end: 9, quote: "Nora Pike" };
    const s10 = p.scenes[9];
    const para10 = segment(s10)[1];
    const span10 = { sceneId: s10.id, paraHash: para10.hash, start: 0, end: 9, quote: "Nora Pike" };
    const ai = {
      [s1.id]: { sceneId: s1.id, paraHashes: [], entities: [], threadBeats: [], facts: [{ entityName: "Nora Pike", attribute: "eyes", value: "blue", span, confidence: 0.8, source: "ai" as const }] },
      [s10.id]: { sceneId: s10.id, paraHashes: [], entities: [], threadBeats: [], facts: [{ entityName: "Nora Pike", attribute: "eyes", value: "grey", span: span10, confidence: 0.8, source: "ai" as const }] },
    };
    expect(runChecks(p, buildModel(p, ai)).some((i) => i.title === "Nora Pike's eye colour changes")).toBe(true);
    s10.text = s10.text.replace("Nora Pike met Hale", "Nora Pike found Hale");
    expect(runChecks(p, buildModel(p, ai)).some((i) => i.title === "Nora Pike's eye colour changes")).toBe(false);
  });
});
