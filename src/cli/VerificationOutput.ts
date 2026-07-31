import qrcode from "qrcode-terminal";

export interface VerificationOutputOptions {
  verificationUrl: string;
  json: boolean;
  qrInstruction: string;
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
  write(`Authorization link:\n${options.verificationUrl}\n\n`);
}
