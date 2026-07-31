import { describe, expect, test } from "vitest";
import { isOptionalAuthorizationSkip } from "../../src/cli/OptionalAuthorizationSkip.js";

describe("isOptionalAuthorizationSkip", () => {
  test.each(["y", "Y", " Y "])("recognizes %j as skip", (input) => {
    expect(isOptionalAuthorizationSkip(input)).toBe(true);
  });

  test.each(["", "yes", "n", "no", "skip", "continue"])(
    "keeps waiting after %j",
    (input) => {
      expect(isOptionalAuthorizationSkip(input)).toBe(false);
    },
  );
});
