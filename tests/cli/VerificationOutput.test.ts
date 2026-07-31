import { describe, expect, test, vi } from "vitest";
import { printVerificationQrAndLink } from "../../src/cli/VerificationOutput.js";

describe("printVerificationQrAndLink", () => {
  test("prints the authorization link after the QR code", () => {
    const output: string[] = [];

    printVerificationQrAndLink(
      {
        verificationUrl: "https://open.feishu.cn/example",
        json: false,
        qrInstruction: "Scan this QR code:",
      },
      (value) => output.push(value),
      (_value, callback) => callback("QR-CODE"),
    );

    const text = output.join("");
    expect(text.indexOf("QR-CODE")).toBeLessThan(text.indexOf("Authorization link:"));
    expect(text.indexOf("Authorization link:")).toBeLessThan(
      text.indexOf("https://open.feishu.cn/example"),
    );
  });

  test("prints only the link in JSON mode", () => {
    const write = vi.fn();
    const renderQr = vi.fn();

    printVerificationQrAndLink(
      {
        verificationUrl: "https://open.feishu.cn/example",
        json: true,
        qrInstruction: "Scan this QR code:",
      },
      write,
      renderQr,
    );

    expect(renderQr).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "Authorization link:\nhttps://open.feishu.cn/example\n\n",
    );
  });
});
