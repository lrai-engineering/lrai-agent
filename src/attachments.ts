import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskAttachment } from "./types.js";

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type FetchFunction = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface AttachmentManifest {
  version: 1;
  attachments: TaskAttachment[];
}

export interface FetchAttachmentsOptions {
  body: string;
  workingDirectory: string;
  manifestPath: string;
  token?: string;
  fetch?: FetchFunction;
}

const IMAGE_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".copilotmd",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".debug",
  ".drawio",
  ".html",
  ".htm",
  ".ipynb",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".log",
  ".md",
  ".patch",
  ".php",
  ".py",
  ".sh",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isSourceHost(url: URL): boolean {
  return (
    (url.hostname === "github.com" &&
      url.pathname.startsWith("/user-attachments/")) ||
    url.hostname === "user-images.githubusercontent.com"
  );
}

function isDownloadHost(url: URL): boolean {
  return (
    url.hostname === "github.com" ||
    url.hostname === "githubusercontent.com" ||
    url.hostname.endsWith(".githubusercontent.com") ||
    /^github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com$/u.test(
      url.hostname,
    )
  );
}

export function extractAttachmentUrls(body: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/https:\/\/[^\s<>"')\]]+/giu)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !isSourceHost(url) || seen.has(url.href)) {
        continue;
      }
      seen.add(url.href);
      urls.push(url.href);
    } catch {
      // Ignore non-URL prose that happens to begin with https://.
    }
  }
  if (urls.length > MAX_ATTACHMENTS) {
    throw new Error(
      `issue contains ${urls.length} GitHub attachments; maximum is ${MAX_ATTACHMENTS}`,
    );
  }
  return urls;
}

function headerFilename(headers: Headers): string | undefined {
  const disposition = headers.get("content-disposition");
  if (disposition === null) return undefined;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/gu, ""));
    } catch {
      return undefined;
    }
  }
  return disposition.match(/filename="?([^";]+)"?/iu)?.[1];
}

function safeFilename(value: string): string {
  const basename = path.basename(value).replace(/[^A-Za-z0-9._-]/gu, "-");
  const trimmed = basename.replace(/^-+|-+$/gu, "").slice(-100);
  return trimmed === "" || trimmed === "." ? "attachment" : trimmed;
}

function normalizeMediaType(headers: Headers): string {
  return (headers.get("content-type") ?? "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function classifyAttachment(
  mediaType: string,
  proposedName: string,
  data: Buffer,
): { kind: TaskAttachment["kind"]; extension: string } {
  const imageExtension = IMAGE_TYPES.get(mediaType);
  if (imageExtension !== undefined) {
    const signatures: Record<string, boolean> = {
      "image/png": data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
      "image/jpeg": data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
      "image/gif": ["GIF87a", "GIF89a"].includes(
        data.subarray(0, 6).toString("ascii"),
      ),
      "image/webp":
        data.subarray(0, 4).toString("ascii") === "RIFF" &&
        data.subarray(8, 12).toString("ascii") === "WEBP",
    };
    if (!signatures[mediaType]) {
      throw new Error(`attachment declared as ${mediaType} but has an invalid signature`);
    }
    return { kind: "image", extension: imageExtension };
  }
  if (mediaType === "application/pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("attachment declared as PDF but has an invalid signature");
    }
    return { kind: "pdf", extension: ".pdf" };
  }

  const extension = path.extname(proposedName).toLowerCase();
  const textualMediaType =
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/ld+json" ||
    mediaType === "application/xml" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml";
  if (textualMediaType || TEXT_EXTENSIONS.has(extension)) {
    if (data.includes(0)) {
      throw new Error("text attachment contains binary null bytes");
    }
    return { kind: "text", extension: extension || ".txt" };
  }
  if (extension === ".pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("PDF attachment has an invalid signature");
    }
    return { kind: "pdf", extension };
  }
  throw new Error(
    `unsupported attachment type ${mediaType} (${extension || "no extension"}); supported types are images, PDF, text, source, and data files`,
  );
}

async function readBounded(
  response: Response,
  sourceUrl: string,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds 10 MiB limit: ${sourceUrl}`);
  }
  if (response.body === null) {
    throw new Error(`attachment response has no body: ${sourceUrl}`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw new Error(`attachment exceeds 10 MiB limit: ${sourceUrl}`);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, size);
}

async function fetchAttachment(
  sourceUrl: string,
  token: string | undefined,
  fetchFunction: FetchFunction,
): Promise<{ data: Buffer; headers: Headers; finalUrl: URL }> {
  let current = new URL(sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isDownloadHost(current)) {
      throw new Error(`attachment redirected to disallowed host: ${current.hostname}`);
    }
    const headers = new Headers({ Accept: "application/octet-stream" });
    if (token !== undefined && current.hostname === "github.com") {
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    }
    const response = await fetchFunction(current.href, {
      headers,
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`attachment exceeded ${MAX_REDIRECTS} redirects`);
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new Error("attachment redirect omitted Location header");
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`attachment download failed with HTTP ${response.status}`);
    }
    return {
      data: await readBounded(response, sourceUrl),
      headers: response.headers,
      finalUrl: current,
    };
  }
  throw new Error("unreachable attachment redirect state");
}

function ensureInsideWorkspace(workingDirectory: string, target: string): void {
  const relative = path.relative(workingDirectory, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("attachment manifest must be inside the checked-out workspace");
  }
}

export async function fetchIssueAttachments(
  options: FetchAttachmentsOptions,
): Promise<AttachmentManifest> {
  const workingDirectory = path.resolve(options.workingDirectory);
  const manifestPath = path.resolve(workingDirectory, options.manifestPath);
  ensureInsideWorkspace(workingDirectory, manifestPath);
  const attachmentDirectory = path.dirname(manifestPath);
  await mkdir(attachmentDirectory);

  const urls = extractAttachmentUrls(options.body);
  const attachments: TaskAttachment[] = [];
  let totalSize = 0;
  const fetchFunction = options.fetch ?? globalThis.fetch;

  for (const [index, url] of urls.entries()) {
    const downloaded = await fetchAttachment(url, options.token, fetchFunction);
    totalSize += downloaded.data.length;
    if (totalSize > MAX_TOTAL_BYTES) {
      throw new Error("GitHub attachments exceed 30 MiB total limit");
    }
    const proposedName =
      headerFilename(downloaded.headers) ??
      path.basename(downloaded.finalUrl.pathname) ??
      `attachment-${index + 1}`;
    const classified = classifyAttachment(
      normalizeMediaType(downloaded.headers),
      proposedName,
      downloaded.data,
    );
    let filename = safeFilename(proposedName);
    const existingExtension = path.extname(filename).toLowerCase();
    if (
      existingExtension === "" ||
      (classified.kind === "image" &&
        ![...IMAGE_TYPES.values()].includes(existingExtension)) ||
      (classified.kind === "pdf" && existingExtension !== ".pdf")
    ) {
      filename = `${path.basename(filename, existingExtension)}${classified.extension}`;
    }
    filename = `${String(index + 1).padStart(2, "0")}-${filename}`;
    const absolutePath = path.join(attachmentDirectory, filename);
    await writeFile(absolutePath, downloaded.data, { mode: 0o600 });
    attachments.push({
      sourceUrl: url,
      path: path.relative(workingDirectory, absolutePath),
      mediaType: normalizeMediaType(downloaded.headers),
      size: downloaded.data.length,
      kind: classified.kind,
    });
  }

  const manifest: AttachmentManifest = { version: 1, attachments };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

export async function loadAttachmentManifest(
  workingDirectory: string,
  manifestValue: string,
): Promise<TaskAttachment[]> {
  const workspace = path.resolve(workingDirectory);
  const manifestPath = path.resolve(workspace, manifestValue);
  ensureInsideWorkspace(workspace, manifestPath);
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("attachments" in parsed) ||
    !Array.isArray(parsed.attachments)
  ) {
    throw new Error("invalid attachment manifest");
  }
  if (parsed.attachments.length > MAX_ATTACHMENTS) {
    throw new Error("attachment manifest exceeds file-count limit");
  }

  const attachments: TaskAttachment[] = [];
  let totalSize = 0;
  for (const value of parsed.attachments) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("sourceUrl" in value) ||
      typeof value.sourceUrl !== "string" ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("mediaType" in value) ||
      typeof value.mediaType !== "string" ||
      !("size" in value) ||
      typeof value.size !== "number" ||
      !("kind" in value) ||
      !["image", "text", "pdf"].includes(String(value.kind))
    ) {
      throw new Error("invalid attachment manifest entry");
    }
    const absolutePath = path.resolve(workspace, value.path);
    ensureInsideWorkspace(workspace, absolutePath);
    const details = await stat(absolutePath);
    if (!details.isFile() || details.size !== value.size || details.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment file does not match manifest: ${value.path}`);
    }
    totalSize += details.size;
    if (totalSize > MAX_TOTAL_BYTES) {
      throw new Error("attachment manifest exceeds total-size limit");
    }
    attachments.push({
      sourceUrl: value.sourceUrl,
      path: path.relative(workspace, absolutePath),
      mediaType: value.mediaType,
      size: value.size,
      kind: value.kind as TaskAttachment["kind"],
    });
  }
  return attachments;
}
