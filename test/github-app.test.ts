import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt, createInstallationToken } from "../src/github-app.js";

describe("GitHub App authentication", () => {
  it("creates a short-lived RS256 App JWT", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const token = createGitHubAppJwt("4822787", privateKey, 1_700_000_000);
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) throw new Error("invalid JWT");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "4822787", iat: 1_699_999_940, exp: 1_700_000_540 });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("requests an installation token with the App JWT", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    let request: RequestInit | undefined;
    const result = await createInstallationToken({ appId: "4822787", privateKeyPath: "/dev/null", privateKey, installationId: 123, fetchImplementation: async (_input, init) => { request = init; return new Response(JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 }); } });
    expect(result.token).toBe("ghs_test");
    expect(request?.method).toBe("POST");
    expect(String((request?.headers as Record<string, string>).authorization)).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });
});
