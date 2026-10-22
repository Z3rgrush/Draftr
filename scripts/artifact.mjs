// Turn the single-file preview build into a page body for a hosted preview:
// the host supplies <html>/<head>/<body>, so keep only the title, styles, markup and script.
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("dist-preview/index.html", "utf8");
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]).join("\n");
const title = pick(/<title>[\s\S]*?<\/title>/g);
const styles = pick(/<style[\s\S]*?<\/style>/g);
const scripts = pick(/<script[\s\S]*?<\/script>/g);
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
// A bundled library has a literal U+FFFD inside a JS string; write it as an escape so the file stays clean text.
const page = `${title}\n${styles}\n${body}\n${scripts}\n`.replaceAll("\uFFFD", "\\uFFFD");
writeFileSync("dist-preview/draftr-preview.html", page);
console.log("wrote dist-preview/draftr-preview.html");
