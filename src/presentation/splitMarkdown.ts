interface FenceState {
  opener: string;
  delimiter: string;
}

export function splitMarkdown(text: string, maxLength = 4_000): string[] {
  if (maxLength < 32) throw new Error("maxLength must be at least 32");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = "";
  let fence: FenceState | undefined;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  const closingSuffix = (): string => {
    if (!fence) return "";
    return `${current.endsWith("\n") ? "" : "\n"}${fence.delimiter}`;
  };

  const flush = (): void => {
    if (!current) return;
    const continuation = fence;
    chunks.push(`${current}${closingSuffix()}`);
    current = continuation ? `${continuation.opener}\n` : "";
  };

  for (const line of lines) {
    const fenceLine = parseFence(line);
    if (fenceLine) {
      const isClosing = fence !== undefined && fenceLine.delimiter.startsWith(fence.delimiter.slice(0, 3));
      const nextFence = isClosing ? undefined : fence ?? fenceLine;
      const reserve = nextFence ? suffixLength(current + line, nextFence.delimiter) : 0;
      if (current && current.length + line.length + reserve > maxLength) flush();
      current += line;
      fence = nextFence;
      continue;
    }

    let remaining = line;
    while (remaining.length > 0) {
      // Reserve the worst-case newline plus delimiter because the appended
      // slice may change a newline-terminated buffer into a partial line.
      const reserve = fence ? fence.delimiter.length + 1 : 0;
      const available = maxLength - current.length - reserve;
      if (available <= 0) {
        flush();
        continue;
      }
      const part = remaining.slice(0, available);
      current += part;
      remaining = remaining.slice(part.length);
      if (remaining.length > 0) flush();
    }
  }

  flush();
  return chunks;
}

function parseFence(line: string): FenceState | undefined {
  const trimmed = line.trimEnd();
  const match = trimmed.match(/^\s*((?:`{3,})|(?:~{3,}))(.*)$/);
  if (!match?.[1]) return undefined;
  return { opener: trimmed.trimStart(), delimiter: match[1] };
}

function suffixLength(value: string, delimiter: string): number {
  return (value.endsWith("\n") ? 0 : 1) + delimiter.length;
}
