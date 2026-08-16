import { describe, expect, test, vi } from "vitest";
import { printVerificationLink } from "../../src/cli/VerificationOutput.js";

describe("printVerificationLink", () => {
  test("prints the authorization link", () => {
    const write = vi.fn();

    printVerificationLink(
      {
        verificationUrl: "https://open.feishu.cn/example",
        language: "en",
      },
      write,
    );

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "Authorization link:\nhttps://open.feishu.cn/example\n\n",
    );
  });

  test("supports a permission-page label", () => {
    const write = vi.fn();

    printVerificationLink(
      {
        verificationUrl: "https://open.feishu.cn/app/cli_created/auth?q=im%3Amessage.group_msg",
        linkLabel: "Permission page",
        language: "en",
      },
      write,
    );

    expect(write).toHaveBeenCalledWith(
      "Permission page:\nhttps://open.feishu.cn/app/cli_created/auth?q=im%3Amessage.group_msg\n\n",
    );
  });

  test("prints a Chinese default link label", () => {
    const write = vi.fn();

    printVerificationLink(
      {
        verificationUrl: "https://open.feishu.cn/example",
        language: "zh",
      },
      write,
    );

    expect(write).toHaveBeenCalledWith(
      "授权链接：\nhttps://open.feishu.cn/example\n\n",
    );
  });
});
