export function truncateText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n...已截断，完整内容请查看本地日志。`;
}

export function codeBlock(text: string, language = ""): string {
  const fenceSafe = text.replaceAll("```", "`\u200b``");
  return `\`\`\`${language}\n${fenceSafe}\n\`\`\``;
}

export function asInlineCode(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}
