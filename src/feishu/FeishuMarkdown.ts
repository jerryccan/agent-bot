interface FenceState {
  indent: string;
  marker: "`" | "~";
  length: number;
  normalizeIndent: boolean;
}

const FENCE_OPENER = /^([ \t]*)((?:`{3,})|(?:~{3,}))(.*)$/;

export function normalizeFeishuMarkdown(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n)|[^\r\n]+$/g) ?? [];
  let fence: FenceState | undefined;

  return lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;

    if (!fence) {
      const opener = FENCE_OPENER.exec(body);
      if (!opener?.[2]) return line;

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

function isFenceCloser(line: string, fence: FenceState): boolean {
  const match = /^[ \t]*(`+|~+)[ \t]*$/.exec(line);
  const delimiter = match?.[1];
  return delimiter !== undefined
    && delimiter[0] === fence.marker
    && delimiter.length >= fence.length;
}
