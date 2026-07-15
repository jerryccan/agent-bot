import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderMarkdownWithLocalImages } from "../../src/feishu/LocalImageMarkdown.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("renderMarkdownWithLocalImages", () => {
  test("replaces local image links with previewable card images in text order", async () => {
    const first = createImage("main.png");
    const second = createImage("secondary.png");
    const upload = vi.fn(async (filePath: string) => `key-${path.basename(filePath)}`);
    const markdown = `前文\n\n[主屏截图](${markdownPath(first)})\n\n中间\n\n![副屏截图](${markdownPath(second)})\n\n后文`;

    const elements = await renderMarkdownWithLocalImages(markdown, upload, vi.fn());

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "img", "markdown", "img", "markdown"]);
    expect(elements[1]).toEqual({
      tag: "img",
      img_key: "key-main.png",
      alt: { tag: "plain_text", content: "主屏截图" },
      title: { tag: "plain_text", content: "主屏截图" },
      mode: "fit_horizontal",
      preview: true,
    });
    expect(elements[3]).toEqual(expect.objectContaining({ img_key: "key-secondary.png", preview: true }));
  });

  test("uploads a repeated path once and leaves remote or missing links unchanged", async () => {
    const image = createImage("same.png");
    const upload = vi.fn(async () => "shared-key");
    const missing = markdownPath(path.join(path.dirname(image), "missing.png"));
    const markdown = `[一](${markdownPath(image)}) [二](${markdownPath(image)}) [网络](https://example.com/a.png) [缺失](${missing})`;

    const elements = await renderMarkdownWithLocalImages(markdown, upload, vi.fn());

    expect(upload).toHaveBeenCalledOnce();
    expect(elements.filter((element) => element.tag === "img")).toHaveLength(2);
    expect(JSON.stringify(elements)).toContain("https://example.com/a.png");
    expect(JSON.stringify(elements)).toContain("missing.png");
  });

  test("keeps the final answer visible when an image upload fails", async () => {
    const image = createImage("failed.png");
    const error = new Error("upload failed");
    const onUploadError = vi.fn();

    const elements = await renderMarkdownWithLocalImages(
      `前文 [失败截图](${markdownPath(image)}) 后文`,
      async () => { throw error; },
      onUploadError,
    );

    expect(JSON.stringify(elements)).toContain("图片上传失败：失败截图");
    expect(JSON.stringify(elements)).toContain("前文");
    expect(JSON.stringify(elements)).toContain("后文");
    expect(onUploadError).toHaveBeenCalledWith(error, path.resolve(image));
  });
});

function createImage(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-image-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "fake image");
  return filePath;
}

function markdownPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
