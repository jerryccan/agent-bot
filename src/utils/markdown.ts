export function truncateText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

export function truncateMiddle(text: string, maxLength = 8000, marker = "\n...\n"): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= marker.length) return ".".repeat(maxLength);
  const retainedLength = maxLength - marker.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = Math.floor(retainedLength / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

export function codeBlock(text: string, language = ""): string {
  const fenceSafe = text.replaceAll("```", "`\u200b``");
  return `\`\`\`${language}\n${fenceSafe}\n\`\`\``;
}

export function asInlineCode(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}
