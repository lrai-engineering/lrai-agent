import { readFile } from "node:fs/promises";
import { createPrivateKey, createSign } from "node:crypto";

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!/^\d+$/.test(appId)) throw new Error("GitHub App ID must contain only digits");
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

export async function createInstallationToken(options: {
  appId: string;
  privateKeyPath: string;
  privateKey?: string;
  installationId: number;
  fetchImplementation?: typeof fetch;
}): Promise<{ token: string; expiresAt: string }> {
  if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0) {
    throw new Error("GitHub installation ID must be a positive integer");
  }
  const privateKey = options.privateKey ?? await readFile(options.privateKeyPath, "utf8");
  const jwt = createGitHubAppJwt(options.appId, privateKey);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    `https://api.github.com/app/installations/${options.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "lrai-agent",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed (${response.status})`);
  }
  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (body.token === undefined || body.expires_at === undefined) {
    throw new Error("GitHub installation token response was incomplete");
  }
  return { token: body.token, expiresAt: body.expires_at };
}
