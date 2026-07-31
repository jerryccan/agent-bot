import { createInterface, type Interface } from "node:readline";

export interface OptionalAuthorizationSkipListener {
  close(): void;
}

export function listenForOptionalAuthorizationSkip(
  onSkip: () => void,
): OptionalAuthorizationSkipListener {
  if (!process.stdin.isTTY) return { close: () => undefined };

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const onLine = (value: string): void => {
    if (!isOptionalAuthorizationSkip(value)) {
      process.stderr.write("Enter Y to skip optional authorization, or keep waiting.\n");
      return;
    }
    process.stderr.write("Optional authorization skipped. Initialization will continue.\n");
    onSkip();
  };
  readline.on("line", onLine);
  process.stderr.write("Skip optional authorization? Enter Y and press Enter to skip.\n");
  return {
    close: () => closeReadline(readline, onLine),
  };
}

export function isOptionalAuthorizationSkip(value: string): boolean {
  return value.trim().toLowerCase() === "y";
}

function closeReadline(readline: Interface, onLine: (value: string) => void): void {
  readline.removeListener("line", onLine);
  readline.close();
}
