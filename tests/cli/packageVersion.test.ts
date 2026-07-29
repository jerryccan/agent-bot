import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { readPackageVersion } from "../../src/cli/packageVersion.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("readPackageVersion", () => {
  test("reads the version from package metadata", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-version-"));
    temporaryDirectories.push(directory);
    const packagePath = path.join(directory, "package.json");
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));

    expect(readPackageVersion(pathToFileURL(packagePath))).toBe("1.2.3");
  });

  test("rejects package metadata without a version", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-version-"));
    temporaryDirectories.push(directory);
    const packagePath = path.join(directory, "package.json");
    fs.writeFileSync(packagePath, "{}");

    expect(() => readPackageVersion(pathToFileURL(packagePath)))
      .toThrow("package.json 中缺少有效的 version");
  });
});
