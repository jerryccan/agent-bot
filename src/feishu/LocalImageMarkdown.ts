import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKDOWN_LINK = /!?\[([^\]]*)\]\(([^)\r\n]+)\)/g;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp", ".ico"]);

export async function renderMarkdownWithLocalImages(
  markdown: string,
  uploadImage: (filePath: string) => Promise<string>,
  onUploadError: (error: unknown, filePath: string) => void,
): Promise<Array<Record<string, unknown>>> {
  const elements: Array<Record<string, unknown>> = [];
  const uploads = new Map<string, Promise<string>>();
  let cursor = 0;

  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const matchIndex = match.index;
    const target = match[2];
    if (matchIndex === undefined || target === undefined) continue;
    const filePath = localImagePath(target);
    if (!filePath) continue;

    appendMarkdown(elements, markdown.slice(cursor, matchIndex));
    const label = match[1]?.trim() || path.basename(filePath);
    try {
      let upload = uploads.get(filePath);
      if (!upload) {
        upload = uploadImage(filePath);
        uploads.set(filePath, upload);
      }
      const imageKey = await upload;
      elements.push({
        tag: "img",
        img_key: imageKey,
        alt: { tag: "plain_text", content: label },
        title: { tag: "plain_text", content: label },
        mode: "fit_horizontal",
        preview: true,
      });
    } catch (error) {
      onUploadError(error, filePath);
      appendMarkdown(elements, `图片上传失败：${label}`);
    }
    cursor = matchIndex + match[0].length;
  }

  appendMarkdown(elements, markdown.slice(cursor));
  return elements;
}

function localImagePath(rawTarget: string): string | undefined {
  const target = unwrapTarget(rawTarget.trim());
  let candidate: string;
  try {
    candidate = target.startsWith("file://") ? fileURLToPath(target) : decodeURIComponent(target);
  } catch {
    return undefined;
  }
  if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(candidate);
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return undefined;
  try {
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function unwrapTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function appendMarkdown(elements: Array<Record<string, unknown>>, content: string): void {
  if (!content) return;
  elements.push({ tag: "markdown", content });
}
