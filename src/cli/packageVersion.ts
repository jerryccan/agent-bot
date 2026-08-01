import fs from "node:fs";
import { cliText } from "./i18n.js";
import { fileURLToPath } from "node:url";

export function readPackageVersion(
  packageJsonUrl = new URL("../../package.json", import.meta.url),
): string {
  const metadata = JSON.parse(
    fs.readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
  ) as { version?: unknown };
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error(cliText(
      "package.json does not contain a valid version.",
      "package.json 中不包含有效版本号。",
    ));
  }
  return metadata.version;
}
