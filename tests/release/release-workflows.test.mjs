import fs from "node:fs";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

const ci = readWorkflow(".github/workflows/ci.yml");
const publish = readWorkflow(".github/workflows/publish.yml");

describe("release workflows", () => {
  test("tests compatibility separately from the verified npm package", () => {
    expect(stepRuns(ci.jobs.test)).toContain("npm test");
    expect(stepRuns(ci.jobs.test)).not.toContain("npm run verify");
    expect(stepRuns(ci.jobs.package)).toEqual(expect.arrayContaining([
      "npm run typecheck",
      "npm run package:smoke",
    ]));
    expect(stepUses(ci.jobs.package)).toContain("actions/upload-artifact@v4");
  });

  test("publishes the exact package artifact produced by CI", () => {
    expect(stepUses(publish.jobs.publish)).toContain("actions/download-artifact@v5");
    const publishCommand = stepRuns(publish.jobs.publish)
      .find((command) => command.startsWith("npm publish "));
    expect(publishCommand).toContain("./${PACKAGE_TARBALL}");
    expect(publishCommand).toContain("--ignore-scripts");
  });

  test("recovers an unpublished release tag after a failed publish attempt", () => {
    const tagCommand = stepRuns(publish.jobs.publish)
      .find((command) => command.includes("git tag --force"));
    expect(tagCommand).toContain("git push --force origin");
    expect(tagCommand).toContain('SHOULD_PUBLISH');
  });
});

function readWorkflow(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function stepRuns(job) {
  return job.steps.flatMap((step) => typeof step.run === "string" ? [step.run.trim()] : []);
}

function stepUses(job) {
  return job.steps.flatMap((step) => typeof step.uses === "string" ? [step.uses] : []);
}
