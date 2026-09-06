import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestedTask, startWebhookServer } from "../src/webhook.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];
const spools: string[] = [];
const secret = "a".repeat(32);

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const spool of spools.splice(0)) await rm(spool, { recursive: true, force: true });
});

describe("GitHub webhook receiver", () => {
  it("treats deploy as an opt-in after implementation", () => {
    expect(requestedTask({ action: "labeled", label: { name: "codex" }, issue: { labels: [{ name: "codex" }, { name: "deploy" }] } }, "issues")).toEqual({ command: "codex", deployPreview: true, consumeLabels: ["codex", "deploy"] });
    expect(requestedTask({ action: "labeled", label: { name: "deploy" }, issue: { labels: [{ name: "codex" }, { name: "deploy" }] } }, "issues")).toEqual({ command: "deploy", deployPreview: true, consumeLabels: ["deploy"] });
    expect(requestedTask({ action: "opened", issue: { labels: [{ name: "deploy" }] } }, "issues")).toEqual({ command: "deploy", deployPreview: true, consumeLabels: ["deploy"] });
    expect(requestedTask({ action: "labeled", label: { name: "deploy" }, issue: { labels: [{ name: "codex" }, { name: "claude" }, { name: "deploy" }] } }, "issues")).toEqual({ command: "deploy", deployPreview: true, consumeLabels: ["deploy"] });
  });

  it("does not turn unrelated labels into tasks", () => {
    expect(requestedTask({ action: "labeled", label: { name: "bug" }, issue: { labels: [{ name: "codex" }] } }, "issues")).toBeUndefined();
    expect(requestedTask({ action: "opened", issue: { labels: [{ name: "codex" }, { name: "claude" }] } }, "issues")).toBeUndefined();
  });

  it("queues an authorized labeled issue", async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-webhook-"));
    spools.push(spool);
    const server = await startWebhookServer({ secret, spoolDirectory: spool, allowedSenders: new Set(["lukasijus"]), port: 0 });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const payload = JSON.stringify({ action: "labeled", label: { name: "codex" }, issue: { number: 4, title: "Test", body: "Do it", user: { login: "lukasijus" }, labels: [{ name: "codex" }] }, sender: { login: "lukasijus" }, repository: { full_name: "lukasijus/test" } });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-hub-signature-256": signature, "x-github-event": "issues", "x-github-delivery": "12345678-abcd", "content-type": "application/json" }, body: payload });
    expect(response.status).toBe(202);
    expect(await readFile(path.join(spool, "12345678-abcd.json"), "utf8")).toContain('"command": "codex"');
  });

  it("rejects an invalid signature", async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-webhook-"));
    spools.push(spool);
    const server = await startWebhookServer({ secret, spoolDirectory: spool, allowedSenders: new Set(["lukasijus"]), port: 0 });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "x-github-event": "issues", "x-github-delivery": "12345678-abcd" }, body: "{}" });
    expect(response.status).toBe(401);
  });

  it("does not overwrite an already queued delivery", async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-webhook-"));
    spools.push(spool);
    const server = await startWebhookServer({ secret, spoolDirectory: spool, allowedSenders: new Set(["lukasijus"]), port: 0 });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const payload = JSON.stringify({ action: "labeled", label: { name: "deploy" }, issue: { number: 2, user: { login: "lukasijus" }, labels: [{ name: "deploy" }] }, sender: { login: "lukasijus" }, repository: { full_name: "lukasijus/calify" } });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const request = { method: "POST", headers: { "x-hub-signature-256": signature, "x-github-event": "issues", "x-github-delivery": "12345678-abcd" }, body: payload };
    const url = `http://127.0.0.1:${address.port}/github/webhook`;
    expect((await fetch(url, request)).status).toBe(202);
    const queued = await readFile(path.join(spool, "12345678-abcd.json"), "utf8");
    expect((await fetch(url, request)).status).toBe(400);
    expect(await readdir(spool)).toEqual(["12345678-abcd.json"]);
    expect(await readFile(path.join(spool, "12345678-abcd.json"), "utf8")).toBe(queued);
  });

  it("ignores signed commands from an unauthorized sender", async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-webhook-"));
    spools.push(spool);
    const server = await startWebhookServer({ secret, spoolDirectory: spool, allowedSenders: new Set(["lukasijus"]), port: 0 });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const payload = JSON.stringify({ action: "labeled", label: { name: "codex" }, issue: { number: 2, user: { login: "outsider" }, labels: [{ name: "codex" }] }, sender: { login: "outsider" } });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-hub-signature-256": signature, "x-github-event": "issues", "x-github-delivery": "12345678-abcd" }, body: payload });
    expect(await response.json()).toEqual({ status: "ignored" });
    expect(await readdir(spool)).toEqual([]);
  });

  it("accepts a signed payload up to 10 MiB", async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-webhook-"));
    spools.push(spool);
    const server = await startWebhookServer({ secret, spoolDirectory: spool, allowedSenders: new Set(["lukasijus"]), port: 0 });
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const payload = JSON.stringify({ action: "opened", issue: { number: 5, title: "Large", body: "x".repeat(9 * 1_048_576), user: { login: "lukasijus" }, labels: [{ name: "codex-plan" }] }, sender: { login: "lukasijus" }, repository: { full_name: "lukasijus/test" } });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-hub-signature-256": signature, "x-github-event": "issues", "x-github-delivery": "12345678-abcd-1234" }, body: payload });
    expect(response.status).toBe(202);
  });
});
