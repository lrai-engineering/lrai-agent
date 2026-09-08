import { createHmac, timingSafeEqual } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { WebhookCommand } from "./types.js";

const MAX_BODY_BYTES = 10 * 1_048_576;
const LABEL_COMMANDS = new Set([
  "codex",
  "claude",
  "codex-plan",
  "claude-plan",
]);
const IMPLEMENT_COMMANDS = new Set(["codex", "claude"]);

export interface WebhookOptions {
  host?: string;
  port?: number;
  secret: string;
  spoolDirectory: string;
  allowedSenders: Set<string>;
}

interface GitHubIssuePayload {
  action?: string;
  issue?: {
    created_at?: string;
    updated_at?: string;
    number?: number;
    title?: string;
    body?: string | null;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
  };
  label?: { name?: string };
  sender?: { login?: string };
  repository?: { full_name?: string; default_branch?: string };
  installation?: { id?: number };
  comment?: { body?: string | null };
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: body }));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("webhook payload is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function validSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = header.slice("sha256=".length);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export interface WebhookDecision {
  command: WebhookCommand;
  deployPreview: boolean;
  consumeLabels: string[];
}

export function requestedTask(payload: GitHubIssuePayload, event: string): WebhookDecision | undefined {
  if (event === "issues") {
    // GitHub emits one labeled event per initial label in addition to opened.
    // The opened snapshot already includes those labels. Handle it exactly once,
    // regardless of delivery order; later label changes have an updated timestamp.
    if (payload.action === "labeled" && payload.issue?.created_at &&
        payload.issue.created_at === payload.issue.updated_at) return undefined;
    const allLabels = (payload.issue?.labels ?? [])
      .map((label) => label.name)
      .filter((label): label is string => label !== undefined);
    const commands = allLabels.filter((label) => LABEL_COMMANDS.has(label));
    const deploy = allLabels.includes("deploy");

    if (payload.action === "opened") {
      if (commands.length === 1) {
        const command = commands[0];
        if (command === undefined) return undefined;
        return { command: command as WebhookCommand, deployPreview: IMPLEMENT_COMMANDS.has(command) && deploy, consumeLabels: [command, ...(deploy ? ["deploy"] : [])] };
      }
      return commands.length === 0 && deploy ? { command: "deploy", deployPreview: true, consumeLabels: ["deploy"] } : undefined;
    }

    if (payload.action === "labeled" && payload.label?.name === "deploy" && deploy) {
      return { command: "deploy", deployPreview: true, consumeLabels: ["deploy"] };
    }
    if (payload.action === "labeled" && payload.label?.name !== undefined && LABEL_COMMANDS.has(payload.label.name)) {
      if (commands.length !== 1) return undefined;
      const command = commands[0];
      if (command === undefined) return undefined;
      return { command: command as WebhookCommand, deployPreview: IMPLEMENT_COMMANDS.has(command) && deploy, consumeLabels: [command, ...(deploy ? ["deploy"] : [])] };
    }
    return undefined;
  }
  if (event === "issue_comment" && payload.action === "created") {
    const match = payload.comment?.body?.match(/^\/lrai-agent\s+(codex|claude|codex-plan|claude-plan|deploy)\s*$/m);
    if (match?.[1] === undefined) return undefined;
    return { command: match[1] as WebhookCommand, deployPreview: match[1] === "deploy", consumeLabels: [] };
  }
  return undefined;
}

function senderIsAllowed(payload: GitHubIssuePayload, event: string, allowed: Set<string>): boolean {
  const issueAuthor = payload.issue?.user?.login;
  const eventSender = payload.sender?.login;
  if (eventSender === undefined || !allowed.has(eventSender)) return false;
  return event === "issue_comment"
    ? true
    : issueAuthor !== undefined && issueAuthor === eventSender;
}

export async function startWebhookServer(options: WebhookOptions): Promise<ReturnType<typeof createServer>> {
  if (options.secret.length < 32) throw new Error("webhook secret must be at least 32 characters");
  if (options.allowedSenders.size === 0) throw new Error("at least one allowed sender is required");
  await mkdir(options.spoolDirectory, { recursive: true, mode: 0o700 });

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        send(response, 200, "ok");
        return;
      }
      if (request.method !== "POST" || request.url !== "/github/webhook") {
        send(response, 404, "not found");
        return;
      }
      const body = await readBody(request);
      const signature = request.headers["x-hub-signature-256"];
      if (!validSignature(body, typeof signature === "string" ? signature : undefined, options.secret)) {
        send(response, 401, "invalid signature");
        return;
      }
      const event = request.headers["x-github-event"];
      const delivery = request.headers["x-github-delivery"];
      if (typeof event !== "string" || typeof delivery !== "string" || !/^[a-f0-9-]{8,100}$/i.test(delivery)) {
        send(response, 400, "missing webhook headers");
        return;
      }
      const payload = JSON.parse(body.toString("utf8")) as GitHubIssuePayload;
      const decision = requestedTask(payload, event);
      if (decision === undefined || !senderIsAllowed(payload, event, options.allowedSenders)) {
        send(response, 202, "ignored");
        return;
      }
      const task = {
        delivery,
        event,
        command: decision.command,
        ...(decision.deployPreview ? { deployPreview: true } : {}),
        consumeLabels: decision.consumeLabels,
        receivedAt: new Date().toISOString(),
        repository: payload.repository?.full_name,
        defaultBranch: payload.repository?.default_branch,
        issueNumber: payload.issue?.number,
        title: payload.issue?.title,
        body: payload.issue?.body ?? "",
        sender: payload.sender?.login,
        installationId: payload.installation?.id,
        payload,
      };
      const filename = path.join(options.spoolDirectory, `${delivery}.json`);
      // A consumed delivery moves forward through these names. Check in that
      // order so a concurrent worker rename does not hide an accepted delivery.
      for (const suffix of ["", ".processing", ".done", ".failed"]) {
        if (await access(`${filename}${suffix}`).then(() => true, () => false)) {
          send(response, 202, "duplicate");
          return;
        }
      }
      try {
        await writeFile(filename, JSON.stringify(task, null, 2), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        send(response, 202, "duplicate");
        return;
      }
      send(response, 202, "queued");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(response, message === "webhook payload is too large" ? 413 : 400, message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8095, options.host ?? "127.0.0.1", () => resolve());
  });
  return server;
}
