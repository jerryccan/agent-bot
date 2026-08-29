import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";

const temporaryDirectories: string[] = [];
const servers: LocalFileViewerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalFileViewerServer", () => {
  test("serves signed text previews with stable line anchors and raw content", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "example.ts");
    fs.writeFileSync(filePath, "const value = '<safe>';\nconsole.log(value);\n", "utf8");
    const server = await startServer(directory);

    const fileUrl = server.createFileUrl(filePath, ":2:4");
    expect(fileUrl).toBeDefined();
    expect(fileUrl).toContain("#L2");

    const pageResponse = await fetch(fileUrl!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("example.ts");
    expect(page).toContain("id=\"L2\"");
    expect(page).toContain("&lt;safe&gt;");
    expect(page).not.toContain("const value = '<safe>'");

    const rawLink = /href="([^"]+)">打开原始文件/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(rawLink).toBeDefined();
    const rawResponse = await fetch(rawLink!);
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe("const value = '<safe>';\nconsole.log(value);\n");
  });

  test("detects text from content instead of the file extension", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "extensionless-data.bin");
    fs.writeFileSync(filePath, "human-readable content\nsecond line\n", "utf8");
    const server = await startServer(directory);

    const pageResponse = await fetch(server.createFileUrl(filePath)!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("human-readable content");
    expect(page).toContain("id=\"L2\"");
    expect(page).not.toContain("该文件是二进制格式");
  });

  test("does not decode binary content as text even when the extension looks textual", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "not-really-text.txt");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
    const server = await startServer(directory);

    const pageResponse = await fetch(server.createFileUrl(filePath)!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("该文件是二进制格式");
    expect(page).not.toContain("class=\"code\"");

    const rawLink = /href="([^"]+)">打开原始文件/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    const rawResponse = await fetch(rawLink!);
    expect(rawResponse.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("detects and decodes UTF-16 text from its byte-order mark", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "utf16.data");
    fs.writeFileSync(filePath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Agent Bot 文本\n", "utf16le"),
    ]));
    const server = await startServer(directory);

    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toContain("Agent Bot 文本");
    expect(page).not.toContain("该文件是二进制格式");
  });

  test("lists signed directory contents and opens nested paths", async () => {
    const directory = createTemporaryDirectory();
    const childDirectory = path.join(directory, "child");
    fs.mkdirSync(childDirectory);
    fs.writeFileSync(path.join(directory, "notes.data"), "directory text\n", "utf8");
    fs.writeFileSync(path.join(childDirectory, "nested.txt"), "nested content\n", "utf8");
    const server = await startServer(path.join(directory, ".viewer-state"));

    const directoryUrl = server.createFileUrl(directory);
    expect(directoryUrl).toBeDefined();
    const pageResponse = await fetch(directoryUrl!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("📁 child");
    expect(page).toContain("📄 notes.data");
    expect(page).not.toContain("打开原始文件");
    expect(page).not.toContain(">..</");

    const childLink = /<a class="directory-entry" href="([^"]+)"><span class="entry-name">📁 child<\/span>/u
      .exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(childLink).toBeDefined();
    const childPage = await (await fetch(childLink!)).text();
    expect(childPage).toContain("nested.txt");
  });

  test("rejects modified signatures and files that no longer exist", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "notes.md");
    fs.writeFileSync(filePath, "# Notes\n", "utf8");
    const server = await startServer(directory);
    const fileUrl = new URL(server.createFileUrl(filePath)!);

    fileUrl.searchParams.set("sig", "0".repeat(64));
    expect((await fetch(fileUrl)).status).toBe(403);

    const validUrl = server.createFileUrl(filePath)!;
    fs.rmSync(filePath);
    expect((await fetch(validUrl)).status).toBe(404);
  });

  test("persists an automatically selected port for the Profile", async () => {
    const directory = createTemporaryDirectory();
    const first = await startServer(directory);
    const firstAddress = await first.start();
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await startServer(directory);
    const secondAddress = await second.start();
    expect(secondAddress.port).toBe(firstAddress.port);
    expect(fs.readFileSync(path.join(directory, "port"), "utf8").trim()).toBe(String(firstAddress.port));
  });
});

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-viewer-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(stateDirectory: string): Promise<LocalFileViewerServer> {
  const server = new LocalFileViewerServer({
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
  });
  servers.push(server);
  await server.start();
  return server;
}
