interface FenceState {
  indent: string;
  marker: "`" | "~";
  length: number;
  normalizeIndent: boolean;
}

const FENCE_OPENER = /^([ \t]*)((?:`{3,})|(?:~{3,}))(.*)$/;
const MARKDOWN_LINK = /(!?)\[([^\]\r\n]*)\]\((<?[^)\r\n]+>?)\)/g;
const LOCAL_FILE_LINE_REFERENCE = /(:\d+(?::\d+)?)$/;

export function normalizeFeishuMarkdown(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n)|[^\r\n]+$/g) ?? [];
  let fence: FenceState | undefined;

  return lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;

    if (!fence) {
      const opener = FENCE_OPENER.exec(body);
      if (!opener?.[2]) return `${includeLocalFileLineReferences(body)}${ending}`;

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

function includeLocalFileLineReferences(markdown: string): string {
  return markdown.replace(MARKDOWN_LINK, (link, imageMarker: string, label: string, rawTarget: string) => {
    if (imageMarker) return link;

    const target = unwrapMarkdownTarget(rawTarget.trim());
    if (!isLocalFileTarget(target)) return link;

    const reference = LOCAL_FILE_LINE_REFERENCE.exec(target)?.[1];
    if (!reference || label.endsWith(reference)) return link;
    return `[${label}${reference}](${rawTarget})`;
  });
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
