import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractAttachmentUrls,
  fetchIssueAttachments,
  loadAttachmentManifest,
} from "../src/attachments.js";

const attachmentUrl =
  "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

describe("extractAttachmentUrls", () => {
  it("keeps only deduplicated GitHub attachment URLs", () => {
    expect(
      extractAttachmentUrls(
        `![screen](${attachmentUrl})\n${attachmentUrl}\nhttps://example.com/file.png`,
      ),
    ).toEqual([attachmentUrl]);
  });

  it("rejects more than eight GitHub attachments", () => {
    const body = Array.from(
      { length: 9 },
      (_, index) =>
        `https://github.com/user-attachments/assets/12345678-1234-1234-1234-${String(index).padStart(12, "0")}`,
    ).join("\n");
    expect(() => extractAttachmentUrls(body)).toThrow("maximum is 8");
  });
});

describe("fetchIssueAttachments", () => {
  it("downloads an image through an allowed redirect without forwarding the token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-attachments-"));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push({
        url: input,
        authorization: headers.get("authorization"),
      });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://github-production-user-asset-6210df.s3.amazonaws.com/image",
          },
        });
      }
      return new Response(png, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-disposition": 'attachment; filename="bug screenshot.png"',
        },
      });
    });

    const manifest = await fetchIssueAttachments({
      body: `![bug](${attachmentUrl})`,
      workingDirectory: directory,
      manifestPath: ".lrai-agent-attachments/manifest.json",
      token: "secret-token",
      fetch: fetchMock,
    });

    expect(requests).toEqual([
      { url: attachmentUrl, authorization: "Bearer secret-token" },
      {
        url: "https://github-production-user-asset-6210df.s3.amazonaws.com/image",
        authorization: null,
      },
    ]);
    expect(manifest.attachments).toHaveLength(1);
    expect(manifest.attachments[0]).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      path: ".lrai-agent-attachments/01-bug-screenshot.png",
      size: png.length,
    });
    expect(
      await readFile(path.join(directory, manifest.attachments[0]!.path)),
    ).toEqual(png);
  });

  it("fails before reading a declared attachment larger than 10 MiB", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-attachments-"));
    await expect(
      fetchIssueAttachments({
        body: attachmentUrl,
        workingDirectory: directory,
        manifestPath: ".lrai-agent-attachments/manifest.json",
        fetch: async () =>
          new Response(new Uint8Array(), {
            headers: {
              "content-length": String(10 * 1024 * 1024 + 1),
              "content-type": "image/png",
            },
          }),
      }),
    ).rejects.toThrow("exceeds 10 MiB");
  });

  it("rejects redirects outside GitHub-owned download hosts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-attachments-"));
    await expect(
      fetchIssueAttachments({
        body: attachmentUrl,
        workingDirectory: directory,
        manifestPath: ".lrai-agent-attachments/manifest.json",
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/private.png" },
          }),
      }),
    ).rejects.toThrow("disallowed host");
  });
});

describe("loadAttachmentManifest", () => {
  it("rejects attachment paths outside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-manifest-"));
    const manifestDirectory = path.join(directory, ".lrai-agent-attachments");
    await mkdir(manifestDirectory);
    await writeFile(
      path.join(manifestDirectory, "manifest.json"),
      JSON.stringify({
        version: 1,
        attachments: [
          {
            sourceUrl: attachmentUrl,
            path: "../outside.txt",
            mediaType: "text/plain",
            size: 1,
            kind: "text",
          },
        ],
      }),
    );

    await expect(
      loadAttachmentManifest(
        directory,
        ".lrai-agent-attachments/manifest.json",
      ),
    ).rejects.toThrow("must be inside the checked-out workspace");
  });
});
