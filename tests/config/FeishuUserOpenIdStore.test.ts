import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { persistFeishuUserOpenIdIfMissing } from "../../src/config/FeishuUserOpenIdStore.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("persistFeishuUserOpenIdIfMissing", () => {
  test("fills a blank value while preserving the environment file", () => {
    const directory = temporaryDirectory();
    const envPath = path.join(directory, ".env");
    fs.writeFileSync(envPath, [
      "# keep this comment",
      "FEISHU_APP_ID=cli_app",
      "FEISHU_USER_OPEN_ID=",
      "CUSTOM_VALUE=keep",
      "",
    ].join("\r\n"), "utf8");

    expect(persistFeishuUserOpenIdIfMissing(envPath, "ou_first_user")).toEqual({
      status: "stored",
      userOpenId: "ou_first_user",
    });
    expect(fs.readFileSync(envPath, "utf8")).toBe([
      "# keep this comment",
      "FEISHU_APP_ID=cli_app",
      "FEISHU_USER_OPEN_ID=ou_first_user",
      "CUSTOM_VALUE=keep",
      "",
    ].join("\r\n"));
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("does not overwrite an existing user", () => {
    const directory = temporaryDirectory();
    const envPath = path.join(directory, ".env");
    fs.writeFileSync(envPath, "FEISHU_USER_OPEN_ID=ou_existing_user\n", "utf8");

    expect(persistFeishuUserOpenIdIfMissing(envPath, "ou_other_user")).toEqual({
      status: "existing",
      userOpenId: "ou_existing_user",
    });
    expect(fs.readFileSync(envPath, "utf8")).toBe("FEISHU_USER_OPEN_ID=ou_existing_user\n");
  });

  test("rejects identifiers that are not Lark user Open IDs", () => {
    const directory = temporaryDirectory();
    const envPath = path.join(directory, ".env");

    expect(() => persistFeishuUserOpenIdIfMissing(envPath, "on_union_id")).toThrow(
      "invalid Lark user Open ID",
    );
    expect(fs.existsSync(envPath)).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-user-open-id-"));
  directories.push(directory);
  return directory;
}
