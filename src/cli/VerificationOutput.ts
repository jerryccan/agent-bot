import qrcode from "qrcode-terminal";
import { cliText, type CliLanguage } from "./i18n.js";

export interface VerificationOutputOptions {
  verificationUrl: string;
  json: boolean;
  qrInstruction: string;
  linkLabel?: string;
  language?: CliLanguage;
}

export function printVerificationQrAndLink(
  options: VerificationOutputOptions,
  write: (value: string) => void = (value) => process.stderr.write(value),
  renderQr: (
    value: string,
    callback: (output: string) => void,
  ) => void = (value, callback) => qrcode.generate(value, { small: true }, callback),
): void {
  if (!options.json) {
    write(`\n${options.qrInstruction}\n\n`);
    renderQr(options.verificationUrl, (output) => write(`${output}\n`));
  }
  write(`${options.linkLabel ?? cliText("Authorization link", "授权链接", options.language)}${cliText(":", "：", options.language)}\n${options.verificationUrl}\n\n`);
}
