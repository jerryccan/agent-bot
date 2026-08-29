import path from "node:path";

interface FenceState {
  indent: string;
  marker: "`" | "~";
  length: number;
  normalizeIndent: boolean;
}

const FENCE_OPENER = /^([ \t]*)((?:`{3,})|(?:~{3,}))(.*)$/;
const MARKDOWN_LINK = /(!?)\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;
const LOCAL_FILE_LINE_REFERENCE = /(:\d+(?::\d+)?)$/;
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp", ".ico"]);

export type LocalFileUrlResolver = (filePath: string, reference?: string) => string | undefined;

export function normalizeFeishuMarkdown(
  markdown: string,
  projectCwd?: string,
  localFileUrl?: LocalFileUrlResolver,
): string {
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n)|[^\r\n]+$/g) ?? [];
  let fence: FenceState | undefined;

  return lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;

    if (!fence) {
      const opener = FENCE_OPENER.exec(body);
      if (!opener?.[2]) return `${includeLocalFileLineReferences(body, projectCwd, localFileUrl)}${ending}`;

      const indent = opener[1] ?? "";
      const delimiter = opener[2];
      fence = {
        indent,
        marker: delimiter[0] as "`" | "~",
        length: delimiter.length,
        normalizeIndent: indent.length > 0,
      };
      return `${fence.normalizeIndent ? body.slice(indent.length) : body}${ending}`;
    }

    const normalizedBody = fence.normalizeIndent && body.startsWith(fence.indent)
      ? body.slice(fence.indent.length)
      : body;
    if (isFenceCloser(normalizedBody, fence)) fence = undefined;
    return `${normalizedBody}${ending}`;
  }).join("");
}

function includeLocalFileLineReferences(
  markdown: string,
  projectCwd?: string,
  localFileUrl?: LocalFileUrlResolver,
): string {
  return markdown.replace(MARKDOWN_LINK, (link, imageMarker: string, label: string, rawTarget: string) => {
    if (imageMarker) return link;

    const target = unwrapMarkdownTarget(rawTarget.trim());
    if (!isLocalFileTarget(target)) return link;
    if (isLocalImageTarget(target)) return link;

    const reference = LOCAL_FILE_LINE_REFERENCE.exec(target)?.[1];
    const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
    const filePath = localFilePath(targetWithoutReference);
    const viewerUrl = filePath ? localFileUrl?.(filePath, reference) : undefined;
    const projectPathLabel = projectCwd ? projectFilePathLabel(target, projectCwd, reference) : undefined;
    if (!projectPathLabel) {
      const normalizedLabel = reference && !label.endsWith(reference) ? `${label}${reference}` : label;
      if (viewerUrl) return `[${normalizedLabel}](${viewerUrl})`;
      return normalizedLabel === label ? link : `[${normalizedLabel}](${rawTarget})`;
    }

    if (projectPathLabel === label) return viewerUrl ? `[${label}](${viewerUrl})` : link;
    if (reference && projectPathLabel === `${label}${reference}`) {
      return `[${projectPathLabel}](${viewerUrl ?? rawTarget})`;
    }

    if (!label) return viewerUrl ? `[${projectPathLabel}](${viewerUrl})` : inlineCode(projectPathLabel);
    return viewerUrl
      ? `[${label}](${viewerUrl})(${inlineCode(projectPathLabel)})`
      : `${label}(${inlineCode(projectPathLabel)})`;
  });
}

function projectFilePathLabel(
  target: string,
  projectCwd: string,
  reference: string | undefined,
): string | undefined {
  const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
  const filePath = localFilePath(targetWithoutReference);
  if (!filePath) return undefined;
  if (!isInsideProject(filePath, projectCwd)) {
    return `${displayAbsolutePath(filePath)}${reference ?? ""}`;
  }

  const pathApi = usesWindowsPaths(filePath, projectCwd) ? path.win32 : path.posix;
  const parsed = pathApi.parse(filePath);
  return `${parsed.base}${reference ?? ""}`;
}

function localFilePath(target: string): string | undefined {
  if (!/^file:\/\//i.test(target)) return normalizeWindowsDrivePrefix(target);

  let value = target.slice("file://".length);
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep malformed percent escapes visible instead of dropping the link.
  }
  if (/^\/[a-z]:[\\/]/i.test(value)) return value.slice(1);
  if (value.startsWith("/")) return value;
  return `//${value}`;
}

function normalizeWindowsDrivePrefix(value: string): string {
  return /^\/[a-z]:[\\/]/i.test(value) ? value.slice(1) : value;
}

function isInsideProject(filePath: string, projectCwd: string): boolean {
  const pathApi = usesWindowsPaths(filePath, projectCwd) ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(projectCwd), pathApi.resolve(filePath));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function displayAbsolutePath(filePath: string): string {
  if (!usesWindowsPaths(filePath)) return path.posix.normalize(filePath);
  return path.win32.normalize(filePath);
}

function inlineCode(value: string): string {
  const longestDelimiter = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestDelimiter + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^\/?[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value));
}

function isLocalImageTarget(target: string): boolean {
  const reference = LOCAL_FILE_LINE_REFERENCE.exec(target)?.[1];
  const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
  const filePath = localFilePath(targetWithoutReference);
  if (!filePath) return false;
  const pathApi = usesWindowsPaths(filePath) ? path.win32 : path.posix;
  return LOCAL_IMAGE_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
}

function unwrapMarkdownTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function isLocalFileTarget(target: string): boolean {
  return /^file:\/\//i.test(target)
    || /^\/?[a-z]:[\\/]/i.test(target)
    || /^\\\\/.test(target)
    || /^\/(?!\/)/.test(target);
}

function isFenceCloser(line: string, fence: FenceState): boolean {
  const match = /^[ \t]*(`+|~+)[ \t]*$/.exec(line);
  const delimiter = match?.[1];
  return delimiter !== undefined
    && delimiter[0] === fence.marker
    && delimiter.length >= fence.length;
}
