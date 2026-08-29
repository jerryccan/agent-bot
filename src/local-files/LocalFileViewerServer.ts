import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  selectPreferredNetworkAddress,
  type NetworkConnectionKind,
} from "./NetworkAddressSelector.js";

const SECRET_FILE = "secret";
const PORT_FILE = "port";
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_SAMPLE_BYTES = 64 * 1024;
const DIRECTORY_PAGE_SIZE = 100;

type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

type FileContentClassification =
  | { kind: "text"; encoding: TextEncoding }
  | { kind: "binary" };

type DirectoryViewerEntryKind = "directory" | "text" | "image" | "pdf" | "media" | "binary";

interface DirectoryViewerEntry {
  name: string;
  path: string;
  stat: fs.Stats;
  kind: DirectoryViewerEntryKind;
}

export interface LocalFileViewerServerOptions {
  host: string;
  port: number;
  publicBaseUrl?: string;
  stateDirectory: string;
}

export interface LocalFileViewerAddress {
  host: string;
  port: number;
  publicBaseUrl: string;
  publicInterface?: string;
  publicConnectionKind?: NetworkConnectionKind;
}

export class LocalFileViewerServer {
  private server?: http.Server;
  private secret?: Buffer;
  private address?: LocalFileViewerAddress;
  private basePath = "";

  constructor(private readonly options: LocalFileViewerServerOptions) {}

  async start(): Promise<LocalFileViewerAddress> {
    if (this.address) return this.address;

    fs.mkdirSync(this.options.stateDirectory, { recursive: true });
    this.secret = readOrCreateSecret(path.join(this.options.stateDirectory, SECRET_FILE));
    const configuredPublicBaseUrl = this.options.publicBaseUrl
      ? normalizePublicBaseUrl(this.options.publicBaseUrl)
      : undefined;

    const configuredPort = this.options.port;
    const persistedPort = configuredPort === 0
      ? readPersistedPort(path.join(this.options.stateDirectory, PORT_FILE))
      : undefined;
    const preferredPort = configuredPort || persistedPort || 0;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.sendHtml(response, 500, errorPage("无法读取文件", "本地文件查看服务处理请求时发生错误。"));
      });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

    let selectedPort = preferredPort;
    try {
      await listen(server, this.options.host, selectedPort);
    } catch (error) {
      if (configuredPort !== 0 || preferredPort === 0 || !isAddressInUse(error)) throw error;
      selectedPort = 0;
      await listen(server, this.options.host, selectedPort);
    }

    const boundAddress = server.address();
    if (!boundAddress || typeof boundAddress === "string") {
      await closeServer(server);
      throw new Error("Local file viewer did not bind to a TCP port.");
    }

    try {
      const selectedNetwork = configuredPublicBaseUrl || !isWildcardHost(this.options.host)
        ? undefined
        : selectPreferredNetworkAddress();
      const publicHost = selectedNetwork?.address ?? urlHost(this.options.host);
      const publicBaseUrl = configuredPublicBaseUrl
        ?? normalizePublicBaseUrl(`http://${urlHost(publicHost)}:${boundAddress.port}`);
      this.basePath = normalizeBasePath(new URL(publicBaseUrl).pathname);
      if (configuredPort === 0 && persistedPort !== boundAddress.port) {
        fs.writeFileSync(path.join(this.options.stateDirectory, PORT_FILE), `${boundAddress.port}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      this.server = server;
      this.address = {
        host: this.options.host,
        port: boundAddress.port,
        publicBaseUrl,
        publicInterface: selectedNetwork?.interfaceName,
        publicConnectionKind: selectedNetwork?.kind,
      };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    return this.address;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (server) await closeServer(server);
  }

  createFileUrl(filePath: string, reference?: string): string | undefined {
    if (!this.address || !this.secret) return undefined;
    const absolutePath = normalizeAbsolutePath(filePath);
    if (!absolutePath) return undefined;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() && !stat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    const token = Buffer.from(absolutePath, "utf8").toString("base64url");
    const url = this.createSignedUrl("view", token);
    const line = parseLineReference(reference);
    if (line !== undefined) url.hash = `L${line}`;
    return url.toString();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      this.sendHtml(response, 405, errorPage("不支持的请求", "该服务只接受只读请求。"), request.method === "HEAD");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routeWithinBasePath(requestUrl.pathname, this.basePath);
    const match = /^\/(view|raw)\/([A-Za-z0-9_-]+)$/u.exec(route);
    if (!match?.[1] || !match[2]) {
      this.sendHtml(response, 404, errorPage("文件链接无效", "请从 Agent Bot 的回答中重新打开文件链接。"), request.method === "HEAD");
      return;
    }

    const token = match[2];
    const signature = requestUrl.searchParams.get("sig") ?? "";
    const filePath = this.verifyToken(token, signature);
    if (!filePath) {
      this.sendHtml(response, 403, errorPage("文件链接无效", "签名校验失败，Agent Bot 已拒绝该请求。"), request.method === "HEAD");
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Unsupported path type");
    } catch {
      this.sendHtml(response, 404, errorPage("文件不存在", "文件可能已被移动、重命名或删除。"), request.method === "HEAD");
      return;
    }

    if (match[1] === "raw") {
      if (stat.isDirectory()) {
        this.sendHtml(response, 400, errorPage("无法打开目录", "目录只能通过文件列表页面浏览。"), request.method === "HEAD");
        return;
      }
      this.serveRawFile(request, response, filePath, stat, requestUrl.searchParams.get("download") === "1");
      return;
    }

    const html = stat.isDirectory()
      ? this.renderDirectoryViewer(filePath, stat, token, parseDirectoryPage(requestUrl.searchParams.get("page")))
      : this.renderViewer(filePath, stat, token, signature);
    this.sendHtml(response, 200, html, request.method === "HEAD");
  }

  private verifyToken(token: string, signature: string): string | undefined {
    if (!this.secret || !/^[a-f0-9]{64}$/u.test(signature)) return undefined;
    const expected = this.sign(token);
    const actualBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;

    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      return undefined;
    }
    if (!decoded || decoded.includes("\0") || Buffer.from(decoded, "utf8").toString("base64url") !== token) return undefined;
    return normalizeAbsolutePath(decoded);
  }

  private sign(token: string): string {
    return createHmac("sha256", this.secret!).update(token).digest("hex");
  }

  private createSignedUrl(route: "view" | "raw", token: string): URL {
    const url = new URL(this.address!.publicBaseUrl);
    url.pathname = `${this.basePath}/${route}/${token}`.replace(/\/{2,}/gu, "/");
    url.search = "";
    url.hash = "";
    url.searchParams.set("sig", this.sign(token));
    return url;
  }

  private renderViewer(filePath: string, stat: fs.Stats, token: string, signature: string): string {
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const classification = classifyFileContent(filePath, stat.size);
    const contentType = binaryContentTypeFor(extension);
    const rawUrl = this.createSignedUrl("raw", token);
    rawUrl.searchParams.set("sig", signature);
    const downloadUrl = new URL(rawUrl);
    downloadUrl.searchParams.set("download", "1");

    let content: string;
    if (classification.kind === "text") {
      const preview = readTextPreview(filePath, stat.size, classification.encoding);
      content = `${preview.truncated ? '<div class="notice">文件较大，仅显示开头 2 MiB。可使用下方按钮查看或下载完整文件。</div>' : ""}${renderText(preview.text)}`;
    } else if (contentType.startsWith("image/")) {
      content = `<div class="media"><img src="${escapeAttribute(rawUrl.toString())}" alt="${escapeAttribute(fileName)}"></div>`;
    } else if (contentType === "application/pdf") {
      content = `<object class="document" data="${escapeAttribute(rawUrl.toString())}" type="application/pdf"><p>浏览器无法内嵌该 PDF，请打开原始文件。</p></object>`;
    } else if (contentType.startsWith("audio/")) {
      content = `<div class="media"><audio controls src="${escapeAttribute(rawUrl.toString())}"></audio></div>`;
    } else if (contentType.startsWith("video/")) {
      content = `<div class="media"><video controls src="${escapeAttribute(rawUrl.toString())}"></video></div>`;
    } else {
      content = '<div class="unsupported">该文件是二进制格式，无法直接预览。可以打开原始文件或下载到本地。</div>';
    }

    return renderViewerPage({
      title: fileName,
      filePath,
      metadata: [formatFileSize(stat.size), stat.mtime.toLocaleString()],
      actions: [
        { href: rawUrl.toString(), label: "打开原始文件" },
        { href: downloadUrl.toString(), label: "下载" },
      ],
      content,
    });
  }

  private renderDirectoryViewer(directory: string, stat: fs.Stats, token: string, requestedPage: number): string {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry): DirectoryViewerEntry[] => {
        const entryPath = path.join(directory, entry.name);
        try {
          const entryStat = fs.statSync(entryPath);
          if (!entryStat.isDirectory() && !entryStat.isFile()) return [];
          return [{
            name: entry.name,
            path: entryPath,
            stat: entryStat,
            kind: directoryViewerEntryKind(entryPath, entryStat),
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory")
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const totalPages = Math.max(1, Math.ceil(entries.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages - 1);
    const visibleEntries = entries.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE);
    const rows = visibleEntries.length > 0
      ? visibleEntries.map((entry) => renderDirectoryEntry(entry, this.createFileUrl(entry.path)!)).join("")
      : '<div class="empty-directory">这个目录是空的。</div>';
    const pagination = totalPages > 1
      ? renderDirectoryPagination(page, totalPages, (targetPage) => {
          const url = this.createSignedUrl("view", token);
          url.searchParams.set("page", String(targetPage));
          return url.toString();
        })
      : "";
    const title = path.basename(directory) || directory;
    return renderViewerPage({
      title,
      filePath: directory,
      metadata: [`${entries.length} 项`, stat.mtime.toLocaleString()],
      actions: [],
      content: `<div class="directory-list">${rows}</div>${pagination}`,
    });
  }

  private serveRawFile(
    request: IncomingMessage,
    response: ServerResponse,
    filePath: string,
    stat: fs.Stats,
    download: boolean,
  ): void {
    const extension = path.extname(filePath).toLowerCase();
    const classification = classifyFileContent(filePath, stat.size);
    const contentType = classification.kind === "text"
      ? textContentTypeFor(extension, classification.encoding)
      : binaryContentTypeFor(extension);
    const range = parseRange(request.headers.range, stat.size);
    const fileName = path.basename(filePath);
    const disposition = download ? "attachment" : "inline";
    setSecurityHeaders(response);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    if (range === "invalid") {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const contentLength = stat.size === 0 ? 0 : end - start + 1;
    response.statusCode = range ? 206 : 200;
    response.setHeader("Content-Length", contentLength);
    if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (request.method === "HEAD" || stat.size === 0) {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
  }

  private sendHtml(response: ServerResponse, status: number, html: string, headOnly = false): void {
    const body = Buffer.from(html, "utf8");
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", body.length);
    response.end(headOnly ? undefined : body);
  }
}

function renderViewerPage(input: {
  title: string;
  filePath: string;
  metadata: string[];
  actions: Array<{ href: string; label: string }>;
  content: string;
}): string {
  const metadata = input.metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  const actions = input.actions.length > 0
    ? `<nav class="actions">${input.actions.map((action) => `<a href="${escapeAttribute(action.href)}">${escapeHtml(action.label)}</a>`).join("")}</nav>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} · Agent Bot</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fa; color: #1f2329; }
    header { position: sticky; top: 0; z-index: 2; padding: 14px 22px; background: rgba(255,255,255,.96); border-bottom: 1px solid #dfe3e8; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
    .path { margin-top: 5px; color: #646a73; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .meta { display: flex; gap: 12px; align-items: center; margin-top: 10px; color: #646a73; font-size: 12px; }
    .actions { margin-left: auto; display: flex; gap: 8px; }
    .actions a { color: #1456f0; text-decoration: none; padding: 5px 9px; border: 1px solid #c9d0db; border-radius: 5px; background: #fff; }
    main { padding: 18px 22px 30px; }
    .notice, .unsupported { margin-bottom: 12px; padding: 12px 14px; border: 1px solid #f3cf8f; background: #fff7e6; border-radius: 6px; }
    .code { margin: 0; padding: 12px 0; overflow: auto; border: 1px solid #dfe3e8; border-radius: 6px; background: #fff; color: #1f2329; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
    .line { display: block; min-height: 1.55em; padding-right: 16px; }
    .line:target { background: #fff1b8; }
    .line-number { display: inline-block; width: 4.5em; margin-right: 12px; padding-right: 12px; text-align: right; color: #8f959e; border-right: 1px solid #eceff3; text-decoration: none; user-select: none; }
    .media { display: grid; place-items: center; min-height: 220px; }
    .media img, .media video { max-width: 100%; max-height: calc(100vh - 180px); }
    .media audio { width: min(720px, 100%); }
    .document { width: 100%; height: calc(100vh - 150px); border: 1px solid #dfe3e8; border-radius: 6px; background: #fff; }
    .directory-list { overflow: hidden; border: 1px solid #dfe3e8; border-radius: 6px; background: #fff; }
    .directory-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; align-items: center; min-height: 44px; padding: 8px 14px; color: inherit; text-decoration: none; border-bottom: 1px solid #eceff3; }
    .directory-entry:last-child { border-bottom: 0; }
    .directory-entry:hover { background: #f0f4ff; }
    .entry-name { min-width: 0; overflow-wrap: anywhere; }
    .entry-kind, .entry-detail { color: #8f959e; font-size: 12px; white-space: nowrap; }
    .empty-directory { padding: 36px 18px; color: #8f959e; text-align: center; }
    .pagination { display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 16px; color: #646a73; font-size: 13px; }
    .pagination a { color: #1456f0; text-decoration: none; }
    @media (max-width: 640px) {
      .directory-entry { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
      .entry-detail { grid-column: 1 / -1; padding-left: 28px; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #17181a; color: #e5e6eb; }
      header { background: rgba(32,33,36,.96); border-color: #3a3b3d; }
      .path, .meta, .pagination { color: #a6a9ad; }
      .actions a, .pagination a { color: #8ab4ff; }
      .actions a { border-color: #55585c; background: #292a2d; }
      .code, .directory-list { background: #202124; color: #e8eaed; border-color: #3a3b3d; }
      .directory-entry { border-color: #3a3b3d; }
      .directory-entry:hover { background: #292f3d; }
      .line-number { color: #8b9098; border-color: #3a3b3d; }
      .line:target { background: #594c20; }
      .notice, .unsupported { color: #f5d58a; background: #3b321c; border-color: #705b28; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(input.title)}</h1>
    <div class="path">${escapeHtml(input.filePath)}</div>
    <div class="meta">${metadata}${actions}</div>
  </header>
  <main>${input.content}</main>
</body>
</html>`;
}

function directoryViewerEntryKind(filePath: string, stat: fs.Stats): DirectoryViewerEntryKind {
  if (stat.isDirectory()) return "directory";
  if (classifyFileContent(filePath, stat.size).kind === "text") return "text";
  const contentType = binaryContentTypeFor(path.extname(filePath).toLowerCase());
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) return "media";
  return "binary";
}

function renderDirectoryEntry(entry: DirectoryViewerEntry, viewerUrl: string): string {
  const labels: Record<DirectoryViewerEntryKind, { icon: string; label: string }> = {
    directory: { icon: "📁", label: "目录" },
    text: { icon: "📄", label: "文本" },
    image: { icon: "🖼️", label: "图片" },
    pdf: { icon: "📕", label: "PDF" },
    media: { icon: "🎞️", label: "媒体" },
    binary: { icon: "📦", label: "二进制" },
  };
  const display = labels[entry.kind];
  const detail = entry.kind === "directory"
    ? entry.stat.mtime.toLocaleString()
    : `${formatFileSize(entry.stat.size)} · ${entry.stat.mtime.toLocaleString()}`;
  return `<a class="directory-entry" href="${escapeAttribute(viewerUrl)}"><span class="entry-name">${display.icon} ${escapeHtml(entry.name)}</span><span class="entry-kind">${display.label}</span><span class="entry-detail">${escapeHtml(detail)}</span></a>`;
}

function renderDirectoryPagination(
  page: number,
  totalPages: number,
  pageUrl: (page: number) => string,
): string {
  const previous = page > 0
    ? `<a href="${escapeAttribute(pageUrl(page - 1))}">上一页</a>`
    : "";
  const next = page + 1 < totalPages
    ? `<a href="${escapeAttribute(pageUrl(page + 1))}">下一页</a>`
    : "";
  return `<nav class="pagination">${previous}<span>第 ${page + 1}/${totalPages} 页</span>${next}</nav>`;
}

function readOrCreateSecret(filePath: string): Buffer {
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (/^[a-f0-9]{64}$/u.test(existing)) return Buffer.from(existing, "hex");
    throw new Error(`Invalid local file viewer secret: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32);
  try {
    fs.writeFileSync(filePath, `${secret.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/u.test(existing)) throw new Error(`Invalid local file viewer secret: ${filePath}`);
    return Buffer.from(existing, "hex");
  }
}

function readPersistedPort(filePath: string): number | undefined {
  try {
    const port = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAbsolutePath(filePath: string): string | undefined {
  const normalized = /^\/[a-z]:[\\/]/iu.test(filePath) ? filePath.slice(1) : filePath;
  if (!path.isAbsolute(normalized)) return undefined;
  return path.resolve(normalized);
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local file viewer publicBaseUrl must use http or https.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function normalizeBasePath(value: string): string {
  const pathName = value.replace(/\/+$/u, "");
  return pathName === "/" ? "" : pathName;
}

function routeWithinBasePath(pathName: string, basePath: string): string {
  if (!basePath) return pathName;
  if (!pathName.startsWith(`${basePath}/`)) return "";
  return pathName.slice(basePath.length);
}

function urlHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function parseLineReference(reference: string | undefined): number | undefined {
  if (!reference) return undefined;
  const match = /^:(\d+)(?::\d+)?$/u.exec(reference);
  if (!match?.[1]) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function parseDirectoryPage(value: string | null): number {
  if (!value || !/^\d+$/u.test(value)) return 0;
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function readTextPreview(
  filePath: string,
  size: number,
  encoding: TextEncoding,
): { text: string; truncated: boolean } {
  const length = Math.min(size, MAX_TEXT_PREVIEW_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    const truncated = size > bytesRead;
    return {
      text: decodeText(buffer.subarray(0, bytesRead), encoding, !truncated),
      truncated,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function classifyFileContent(filePath: string, size = fs.statSync(filePath).size): FileContentClassification {
  const length = Math.min(size, MAX_CONTENT_SAMPLE_BYTES);
  if (length === 0) return { kind: "text", encoding: "utf-8" };

  const sample = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(descriptor, sample, 0, length, 0);
    return classifyContentSample(sample.subarray(0, bytesRead), bytesRead >= size);
  } finally {
    fs.closeSync(descriptor);
  }
}

function classifyContentSample(sample: Buffer, complete: boolean): FileContentClassification {
  if (sample.length === 0) return { kind: "text", encoding: "utf-8" };

  if (sample.length >= 4 && (
    sample.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00]))
    || sample.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]))
  )) {
    return { kind: "binary" };
  }

  const bomEncoding = sample[0] === 0xff && sample[1] === 0xfe
    ? "utf-16le"
    : sample[0] === 0xfe && sample[1] === 0xff
      ? "utf-16be"
      : undefined;
  if (bomEncoding) {
    return isTextForEncoding(sample, bomEncoding, complete)
      ? { kind: "text", encoding: bomEncoding }
      : { kind: "binary" };
  }

  if (sample.includes(0)) return { kind: "binary" };

  for (const encoding of ["utf-8", "gb18030"] as const) {
    if (isTextForEncoding(sample, encoding, complete)) return { kind: "text", encoding };
  }
  return { kind: "binary" };
}

function isTextForEncoding(sample: Buffer, encoding: TextEncoding, complete: boolean): boolean {
  try {
    return hasTextLikeCharacters(decodeText(sample, encoding, complete, true));
  } catch {
    return false;
  }
}

function decodeText(
  value: Buffer,
  encoding: TextEncoding,
  complete: boolean,
  fatal = false,
): string {
  const decoder = new TextDecoder(encoding, { fatal });
  return decoder.decode(value, { stream: !complete });
}

function hasTextLikeCharacters(value: string): boolean {
  let controls = 0;
  let characters = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    characters += 1;
    if ((codePoint < 0x20 && ![0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b].includes(codePoint))
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      controls += 1;
    }
  }
  return controls <= 2 || controls / Math.max(1, characters) <= 0.02;
}

function renderText(value: string): string {
  const lines = value.split(/\r?\n/u);
  return `<pre class="code"><code>${lines.map((line, index) => {
    const lineNumber = index + 1;
    return `<span class="line" id="L${lineNumber}"><a class="line-number" href="#L${lineNumber}">${lineNumber}</a>${escapeHtml(line)}</span>`;
  }).join("")}</code></pre>`;
}

function contentTypeFor(extension: string): string {
  const known: Record<string, string> = {
    ".aac": "audio/aac", ".avi": "video/x-msvideo", ".bmp": "image/bmp", ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".gif": "image/gif", ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".m4a": "audio/mp4",
    ".md": "text/markdown; charset=utf-8", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".mpeg": "video/mpeg", ".oga": "audio/ogg", ".ogg": "audio/ogg", ".ogv": "video/ogg", ".pdf": "application/pdf",
    ".png": "image/png", ".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".ts": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".wav": "audio/wav",
    ".webm": "video/webm", ".webp": "image/webp", ".xml": "application/xml; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  };
  return known[extension] ?? "application/octet-stream";
}

function binaryContentTypeFor(extension: string): string {
  const contentType = contentTypeFor(extension);
  return isTextContentType(contentType) ? "application/octet-stream" : contentType;
}

function textContentTypeFor(extension: string, encoding: TextEncoding): string {
  const contentType = contentTypeFor(extension);
  if (!isTextContentType(contentType)) return `text/plain; charset=${encoding}`;
  return contentType.replace(/;\s*charset=[^;]+/iu, `; charset=${encoding}`);
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType.includes("json")
    || contentType.includes("xml")
    || contentType.includes("yaml")
    || contentType === "image/svg+xml";
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return "invalid";

  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Agent Bot</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:12vh auto;padding:0 24px;color:#1f2329}h1{font-size:24px}p{color:#646a73}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
