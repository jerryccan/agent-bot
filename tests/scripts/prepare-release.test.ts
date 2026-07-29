import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const sourceScript = path.resolve("scripts/prepare-release.mjs");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prepare-release", () => {
  it("increments the patch version and archives Unreleased changes", () => {
    const root = createRepository();

    const result = run(root);

    expect(result.status).toBe(0);
    expect(readJson(root, "package.json").version).toBe("1.2.4");
    expect(readJson(root, "npm-shrinkwrap.json")).toMatchObject({
      version: "1.2.4",
      packages: { "": { version: "1.2.4" } },
    });
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(
      /## \[Unreleased\]\n\n## \[1\.2\.4\] - \d{4}-\d{2}-\d{2}\n\n- Pending change\.\n\n- Another pending change\./,
    );
    expect(result.stdout).toContain("Prepared @example/agent-bot@1.2.4.");
  });

  it("supports named version increments", () => {
    const root = createRepository();

    const result = run(root, "minor");

    expect(result.status).toBe(0);
    expect(readJson(root, "package.json").version).toBe("1.3.0");
  });

  it("refuses to modify a dirty worktree", () => {
    const root = createRepository();
    fs.appendFileSync(path.join(root, "CHANGELOG.md"), "\n- Not committed.\n");

    const result = run(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "The Git worktree must be clean before preparing a release.",
    );
    expect(readJson(root, "package.json").version).toBe("1.2.3");
  });
});

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-release-"));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(sourceScript, path.join(root, "scripts/prepare-release.mjs"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@example/agent-bot", version: "1.2.3" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@example/agent-bot",
        version: "1.2.3",
        packages: { "": { name: "@example/agent-bot", version: "1.2.3" } },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "- Pending change.",
      "",
      "- Another pending change.",
      "",
      "## [1.2.3] - 2026-07-01",
      "",
      "- Previous release.",
      "",
    ].join("\n"),
  );
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Agent Bot Tests",
    "-c",
    "user.email=agent-bot@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return root;
}

function run(root: string, version?: string) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/prepare-release.mjs"),
      ...(version ? [version] : []),
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function readJson(root: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}
