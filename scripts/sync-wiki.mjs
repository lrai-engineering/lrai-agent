import { readFile, readdir, mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repo, "docs/wiki");
const [destinationArg, flag] = process.argv.slice(2);
if (!destinationArg || (flag !== undefined && flag !== "--check") || process.argv.length > 4) {
  throw new Error("usage: node scripts/sync-wiki.mjs /path/to/lrai-agent.wiki [--check]");
}
const destination = await realpath(destinationArg);
const git = (...args) => execFileSync("git", ["-C", destination, ...args], { encoding: "utf8" }).trim();
if (await realpath(git("rev-parse", "--show-toplevel")) !== destination) {
  throw new Error("Destination must be the root of the wiki checkout");
}
const remote = git("remote", "get-url", "origin");
if (!["https://github.com/lrai-engineering/lrai-agent.wiki.git", "git@github.com:lrai-engineering/lrai-agent.wiki.git"].includes(remote)) {
  throw new Error("Destination must be the lrai-engineering/lrai-agent wiki repository");
}
if (flag !== "--check" && git("status", "--porcelain")) {
  throw new Error("Wiki checkout has existing changes; commit or preserve them before syncing");
}
const pages = (await readdir(source)).filter((name) => name.endsWith(".md"));
const assets = (await readdir(path.join(source, "assets"))).filter((name) => /\.(puml|svg|png)$/.test(name));
const wikiUrl = "https://github.com/lrai-engineering/lrai-agent/wiki/";
const assetUrl = "https://github.com/lrai-engineering/lrai-agent/blob/main/docs/wiki/assets/";
const differences = [];
for (const filename of [...pages, ...assets.map((name) => `assets/${name}`)]) {
  let bytes = await readFile(path.join(source, filename));
  if (filename.endsWith(".md")) {
    let inFence = false;
    bytes = Buffer.from(bytes.toString().split("\n").map((line) => {
      if (line.startsWith("```")) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/\]\(([A-Za-z0-9_-]+)\.md(#[^)]+)?\)/g,
        (_, name, fragment = "") => `](${wikiUrl}${name}${fragment})`)
        .replace(/\]\(assets\/([A-Za-z0-9_.-]+)\)/g,
          (_, name) => `](${assetUrl}${name}${name.endsWith(".png") ? "?raw=true" : ""})`);
    }).join("\n"));
  }
  const target = path.join(destination, filename);
  let current;
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlink target: ${filename}`);
    current = await readFile(target);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!current?.equals(bytes)) differences.push(filename);
  if (flag !== "--check") {
    await mkdir(path.dirname(target), { recursive: true });
    if (await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error("Refusing symlinked destination directory");
    await writeFile(target, bytes);
  }
}
if (flag === "--check" && differences.length) {
  console.error(`Wiki differs from source: ${differences.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(flag === "--check" ? "Wiki matches source and link conversion." : `Synced ${pages.length} pages and ${assets.length} assets. Review, commit, and push the wiki separately.`);
}
