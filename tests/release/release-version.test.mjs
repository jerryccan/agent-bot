import { describe, expect, test } from "vitest";
import {
  isAlphaVersion,
  parseReleaseVersion,
  resolveNextVersion,
} from "../../scripts/release-version.mjs";

describe("release version resolution", () => {
  test("starts the next patch alpha by default", () => {
    expect(resolveNextVersion("0.1.12")).toBe("0.1.13-alpha.0");
    expect(resolveNextVersion("0.1.12", "alpha")).toBe("0.1.13-alpha.0");
  });

  test("increments the current alpha sequence", () => {
    expect(resolveNextVersion("0.1.13-alpha.0")).toBe("0.1.13-alpha.1");
  });

  test("promotes an alpha or increments a stable patch explicitly", () => {
    expect(resolveNextVersion("0.1.13-alpha.4", "stable")).toBe("0.1.13");
    expect(resolveNextVersion("0.1.13", "stable")).toBe("0.1.14");
    expect(resolveNextVersion("0.1.13-alpha.4", "patch")).toBe("0.1.14");
  });

  test("accepts newer exact stable and alpha versions", () => {
    expect(resolveNextVersion("0.1.12", "0.2.0-alpha.0")).toBe("0.2.0-alpha.0");
    expect(resolveNextVersion("0.2.0-alpha.0", "0.2.0")).toBe("0.2.0");
  });

  test("rejects unsupported or non-increasing versions", () => {
    expect(() => resolveNextVersion("0.1.12", "0.1.12-alpha.1")).toThrow("must be newer");
    expect(() => parseReleaseVersion("0.1.13-beta.0")).toThrow("stable or alpha");
  });

  test("identifies the npm release channel", () => {
    expect(isAlphaVersion("0.1.13-alpha.0")).toBe(true);
    expect(isAlphaVersion("0.1.13")).toBe(false);
  });
});
