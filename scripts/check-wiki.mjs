import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "docs/wiki");
const pages = (await readdir(root)).filter((name) => name.endsWith(".md"));
const failures = [];
let linkCount = 0;
let shellCount = 0;
for (const page of pages) {
  const content = await readFile(path.join(root, page), "utf8");
  const fences = [...content.matchAll(/^```([^\n]*)\n/gm)];
  if (fences.length % 2 !== 0) failures.push(`${page}: unclosed code fence`);
  for (const match of content.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/g)) {
    if (match[1] === "bash") {
      shellCount++;
      const result = spawnSync("bash", ["-n"], { input: match[2], encoding: "utf8" });
      if (result.status !== 0) failures.push(`${page}: invalid shell example: ${result.stderr || result.error}`);
    }
    if (match[1] === "yaml" || match[1] === "json") {
      try { match[1] === "yaml" ? parse(match[2]) : JSON.parse(match[2]); }
      catch (error) { failures.push(`${page}: invalid ${match[1]}: ${error.message}`); }
    }
  }
  const prose = content.replace(/```[^\n]*\n[\s\S]*?\n```/g, "");
  for (const match of prose.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    linkCount++;
    const file = path.resolve(root, target.split("#")[0]);
    if (!file.startsWith(`${root}${path.sep}`)) {
      failures.push(`${page}: link escapes wiki: ${target}`);
      continue;
    }
    try { await stat(file); } catch { failures.push(`${page}: broken local link: ${target}`); }
  }
}
const assets = await readdir(path.join(root, "assets"));
for (const asset of assets.filter((name) => name.endsWith(".puml"))) {
  const source = await readFile(path.join(root, "assets", asset), "utf8");
  if (!source.startsWith("@startuml\n") || !source.trimEnd().endsWith("@enduml")) {
    failures.push(`${asset}: missing PlantUML boundaries`);
  }
  for (const extension of ["svg", "png"]) {
    const rendered = path.join(root, "assets", asset.replace(/\.puml$/, `.${extension}`));
    try {
      const bytes = await readFile(rendered);
      if (extension === "svg" && (!bytes.toString().includes("<svg") || /Syntax Error\?|An error has occurr?ed/i.test(bytes.toString()))) {
        failures.push(`${asset}: invalid/error SVG`);
      }
      if (extension === "png" && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        failures.push(`${asset}: invalid PNG`);
      }
    } catch { failures.push(`${asset}: missing ${extension} rendering`); }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Wiki checks passed: ${pages.length} Markdown files, ${linkCount} local links, ${shellCount} shell examples, ${assets.filter((name) => name.endsWith(".puml")).length} diagrams.`);
}
