interface FenceState {
  opener: string;
  delimiter: string;
}

interface TextRange {
  start: number;
  end: number;
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

  const appendPlainLine = (line: string): void => {
    const atomicRanges = fence ? [] : markdownAtomicRanges(line);
    let offset = 0;
    while (offset < line.length) {
      // Reserve the worst-case newline plus delimiter because the appended
      // slice may change a newline-terminated buffer into a partial line.
      const reserve = fence ? fence.delimiter.length + 1 : 0;
      const available = maxLength - current.length - reserve;
      if (available <= 0) {
        flush();
        continue;
      }

      const continuationPrefix = fence ? `${fence.opener}\n` : "";
      const hasPayload = current.length > continuationPrefix.length;
      const remainingLength = line.length - offset;
      if (remainingLength > available && hasPayload) {
        // Prefer a line boundary over filling the previous chunk. Apart from
        // producing more readable pages, this gives inline Markdown such as
        // links and code spans the full capacity of the next chunk.
        flush();
        continue;
      }

      let partLength = Math.min(remainingLength, available);
      if (!fence && remainingLength > available) {
        partLength = findSafeMarkdownSplit(line, offset, available, atomicRanges);
        // A Markdown construct may itself be larger than the message limit.
        // It cannot be kept intact, so retain the lossless hard-split fallback.
        if (partLength <= 0) partLength = available;
      }
      const part = line.slice(offset, offset + partLength);
      current += part;
      offset += part.length;
      if (offset < line.length) flush();
    }
  };

  const appendTable = (tableLines: string[]): void => {
    const header = tableLines[0];
    const delimiter = tableLines[1];
    if (!header || !delimiter) return;
    const continuationPrefix = `${header}${delimiter}`;
    const firstRow = tableLines[2];
    const headerLength = header.length + delimiter.length;
    const initialTableLength = firstRow && headerLength + firstRow.length <= maxLength
      ? headerLength + firstRow.length
      : headerLength;

    if (current && initialTableLength <= maxLength && current.length + initialTableLength > maxLength) flush();
    if (headerLength <= maxLength) {
      current += header;
      current += delimiter;
    } else {
      appendPlainLine(header);
      appendPlainLine(delimiter);
    }
    for (const row of tableLines.slice(2)) {
      if (current.length + row.length <= maxLength) {
        current += row;
        continue;
      }

      flush();
      if (continuationPrefix.length + row.length <= maxLength) {
        current = continuationPrefix;
        current += row;
        continue;
      }

      // A single data row can itself exceed the card limit. There is no way
      // to preserve it as one Markdown table row in that case, so retain the
      // existing lossless hard-split fallback.
      current = continuationPrefix;
      appendPlainLine(row);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!fence && isTableHeader(line, lines[index + 1])) {
      const tableLines = [line, lines[index + 1]!];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!)) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      index -= 1;
      appendTable(tableLines);
      continue;
    }

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
    appendPlainLine(line);
  }

  flush();
  return chunks;
}

function isTableHeader(line: string, nextLine: string | undefined): boolean {
  return isTableRow(line) && nextLine !== undefined && isTableDelimiter(nextLine);
}

function isTableRow(line: string): boolean {
  const value = line.trim();
  return value.length > 0 && unescapedPipeCount(value) > 0;
}

function isTableDelimiter(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line: string): string[] {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (character === "|" && !escaped) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  cells.push(current);
  return cells;
}

function unescapedPipeCount(value: string): number {
  let count = 0;
  let escaped = false;
  for (const character of value) {
    if (character === "|" && !escaped) count += 1;
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return count;
}

function findSafeMarkdownSplit(value: string, start: number, limit: number, ranges: TextRange[]): number {
  if (value.length - start <= limit) return value.length - start;
  let boundary = start + limit;
  const activeRanges = ranges.filter((range) => range.start >= start);

  for (const range of activeRanges) {
    if (range.start < boundary && boundary < range.end) {
      boundary = range.start;
      break;
    }
  }
  if (boundary <= start) return 0;

  // Prefer a natural reading boundary, provided it is not inside another
  // protected Markdown construct. Whitespace remains in the preceding chunk,
  // so concatenating plain-text chunks is lossless.
  for (let index = boundary; index > start; index -= 1) {
    if (/\s/.test(value[index - 1]!) && isSafeBoundary(index, activeRanges)) return index - start;
  }
  for (let index = boundary; index > start; index -= 1) {
    if (/[，。；：、,.!?;:]/.test(value[index - 1]!) && isSafeBoundary(index, activeRanges)) return index - start;
  }
  return isSafeBoundary(boundary, activeRanges) ? boundary - start : 0;
}

function markdownAtomicRanges(value: string): TextRange[] {
  const ranges: TextRange[] = [];
  collectCodeSpans(value, ranges);
  collectLinksAndImages(value, ranges);
  collectAngleSpans(value, ranges);
  collectEmphasisSpans(value, ranges);
  return mergeRanges(ranges);
}

function collectCodeSpans(value: string, ranges: TextRange[]): void {
  for (let index = 0; index < value.length;) {
    if (value[index] !== "`" || isEscaped(value, index)) {
      index += 1;
      continue;
    }
    const delimiterLength = repeatedCharacterLength(value, index, "`");
    const end = findClosingRun(value, index + delimiterLength, "`", delimiterLength);
    if (end === -1) {
      index += delimiterLength;
      continue;
    }
    ranges.push({ start: index, end: end + delimiterLength });
    index = end + delimiterLength;
  }
}

function collectLinksAndImages(value: string, ranges: TextRange[]): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "[" || isEscaped(value, index)) continue;
    const labelEnd = findMatchingDelimiter(value, index, "[", "]");
    if (labelEnd === -1) continue;

    const start = index > 0 && value[index - 1] === "!" && !isEscaped(value, index - 1)
      ? index - 1
      : index;
    let end = labelEnd + 1;
    if (value[end] === "(") {
      const destinationEnd = findMatchingDelimiter(value, end, "(", ")");
      if (destinationEnd !== -1) end = destinationEnd + 1;
    } else if (value[end] === "[") {
      const referenceEnd = findMatchingDelimiter(value, end, "[", "]");
      if (referenceEnd !== -1) end = referenceEnd + 1;
    }
    ranges.push({ start, end });
    index = end - 1;
  }
}

function collectAngleSpans(value: string, ranges: TextRange[]): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "<" || isEscaped(value, index)) continue;
    const end = findUnescaped(value, ">", index + 1);
    if (end !== -1) {
      ranges.push({ start: index, end: end + 1 });
      index = end;
    }
  }
}

function collectEmphasisSpans(value: string, ranges: TextRange[]): void {
  const delimiters = ["***", "___", "**", "__", "~~", "*", "_"];
  for (let index = 0; index < value.length; index += 1) {
    if (isEscaped(value, index)) continue;
    const delimiter = delimiters.find((candidate) => value.startsWith(candidate, index));
    if (!delimiter || /\s/.test(value[index + delimiter.length] ?? "")) continue;
    const end = findUnescaped(value, delimiter, index + delimiter.length, (candidate) => (
      candidate > index + delimiter.length
      && !/\s/.test(value[candidate - 1] ?? "")
    ));
    if (end === -1) continue;
    ranges.push({ start: index, end: end + delimiter.length });
    index = end + delimiter.length - 1;
  }
}

function findMatchingDelimiter(value: string, start: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (isEscaped(value, index)) continue;
    if (value[index] === opener) depth += 1;
    else if (value[index] === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingRun(value: string, start: number, character: string, length: number): number {
  const delimiter = character.repeat(length);
  return findUnescaped(value, delimiter, start, (index) => (
    value[index - 1] !== character && value[index + length] !== character
  ));
}

function findUnescaped(
  value: string,
  needle: string,
  start: number,
  accept: (index: number) => boolean = () => true,
): number {
  let index = value.indexOf(needle, start);
  while (index !== -1) {
    if (!isEscaped(value, index) && accept(index)) return index;
    index = value.indexOf(needle, index + 1);
  }
  return -1;
}

function repeatedCharacterLength(value: string, start: number, character: string): number {
  let end = start;
  while (value[end] === character) end += 1;
  return end - start;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start >= previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }
  return merged;
}

function isSafeBoundary(index: number, ranges: TextRange[]): boolean {
  return ranges.every((range) => index <= range.start || index >= range.end);
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
