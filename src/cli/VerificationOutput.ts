import { cliText, type CliLanguage } from "./i18n.js";

export interface VerificationOutputOptions {
  verificationUrl: string;
  linkLabel?: string;
  language?: CliLanguage;
}

export function printVerificationLink(
  options: VerificationOutputOptions,
  write: (value: string) => void = (value) => process.stderr.write(value),
): void {
  write(`${options.linkLabel ?? cliText("Authorization link", "授权链接", options.language)}${cliText(":", "：", options.language)}\n${options.verificationUrl}\n\n`);
}
