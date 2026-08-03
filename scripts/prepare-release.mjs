import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlphaVersion, resolveNextVersion } from "./release-version.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packagePath = path.join(repositoryRoot, "package.json");
const shrinkwrapPath = path.join(repositoryRoot, "npm-shrinkwrap.json");
const changelogPath = path.join(repositoryRoot, "CHANGELOG.md");
const requestedVersion = process.argv[2] ?? "alpha";

ensureCleanWorktree();

const packageJson = readJson(packagePath);
const shrinkwrap = readJson(shrinkwrapPath);
const nextVersion = resolveNextVersion(packageJson.version, requestedVersion);
const npmTag = isAlphaVersion(nextVersion) ? "alpha" : "latest";
const changelog = fs.readFileSync(changelogPath, "utf8");
const nextChangelog = prepareChangelog(changelog, nextVersion);

packageJson.version = nextVersion;
shrinkwrap.version = nextVersion;
if (!shrinkwrap.packages?.[""]) {
  throw new Error("npm-shrinkwrap.json is missing its root package entry.");
}
shrinkwrap.packages[""].version = nextVersion;

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
fs.writeFileSync(changelogPath, nextChangelog);

process.stdout.write(
  [
    `Prepared ${packageJson.name}@${nextVersion}.`,
    `npm dist-tag: ${npmTag}`,
    "Review the changes, commit them, and push to master.",
    "GitHub Actions will publish the version after CI succeeds.",
    "",
  ].join("\n"),
);

function ensureCleanWorktree() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || "Could not inspect the Git worktree.",
    );
  }
  if (result.stdout.trim()) {
    throw new Error(
      "The Git worktree must be clean before preparing a release.",
    );
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function prepareChangelog(contents, version) {
  if (
    new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`, "m").test(
      contents,
    )
  ) {
    throw new Error(`CHANGELOG.md already contains a ${version} section.`);
  }

  const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  const normalized = contents.replaceAll("\r\n", "\n");
  const header = /^## \[Unreleased\][^\S\n]*\n/m.exec(normalized);
  if (!header) {
    throw new Error("CHANGELOG.md is missing its Unreleased section.");
  }

  const sectionStart = header.index + header[0].length;
  const nextHeader = /^## \[/gm;
  nextHeader.lastIndex = sectionStart;
  const sectionEnd = nextHeader.exec(normalized)?.index ?? normalized.length;
  const entries = normalized.slice(sectionStart, sectionEnd).trim();
  if (!entries) {
    throw new Error("CHANGELOG.md has no Unreleased entries to publish.");
  }

  const date = new Date().toISOString().slice(0, 10);
  const replacement = [
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    entries,
    "",
    "",
  ].join("\n");
  const updated = `${normalized.slice(0, header.index)}${replacement}${normalized.slice(sectionEnd)}`;
  return updated.replaceAll("\n", lineEnding);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
