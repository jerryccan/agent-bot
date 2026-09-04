export type CliLanguage = "en" | "zh";

export function detectCliLanguage(locale = systemLocale()): CliLanguage {
  return /^zh(?:[-_]|$)/i.test(locale.trim()) ? "zh" : "en";
}

export const cliLanguage = detectCliLanguage();

export function cliText(
  english: string,
  chinese: string,
  language: CliLanguage = cliLanguage,
): string {
  return language === "zh" ? chinese : english;
}

export function localizeCliErrorMessage(
  message: string,
  language: CliLanguage = cliLanguage,
): string {
  if (language !== "zh") return message;

  const missingConfig = /^Config file does not exist: (.+)$/u.exec(message);
  if (missingConfig) return `配置文件不存在：${missingConfig[1]}`;

  const missingAgent = /^Default agent "(.+)" is not configured\.$/u.exec(message);
  if (missingAgent) return `默认 Agent“${missingAgent[1]}”尚未配置。`;

  return message;
}

export function controlFailureMessage(
  message: string | undefined,
  language: CliLanguage = cliLanguage,
): string {
  const detail = message?.trim();
  if (detail) return detail;
  return cliText(
    "Agent Bot control operation failed. Check the server logs for details.",
    "Agent Bot 控制操作失败，请查看服务日志了解详情。",
    language,
  );
}

function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en";
  } catch {
    return "en";
  }
}
