import { describe, expect, it } from "vitest";
import { shouldUseInteractiveInitialization } from "../../src/cli/InitUi.js";

describe("shouldUseInteractiveInitialization", () => {
  it("enables the wizard only for an interactive terminal", () => {
    expect(shouldUseInteractiveInitialization(false, true, true)).toBe(true);
    expect(shouldUseInteractiveInitialization(false, false, true)).toBe(false);
    expect(shouldUseInteractiveInitialization(false, true, false)).toBe(false);
  });

  it("keeps JSON initialization non-interactive", () => {
    expect(shouldUseInteractiveInitialization(true, true, true)).toBe(false);
  });
});
