import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const AVATAR_SIZE = 512;

interface AvatarPalette {
  primary: string;
  accent: string;
  light: string;
  dark: string;
}

export function resolveGroupAvatarProjectName(projectCwd: string | undefined, fallbackTitle: string): string {
  if (!projectCwd) return fallbackTitle;
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectCwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) {
      return manifest.name.trim().split("/").at(-1) ?? manifest.name.trim();
    }
  } catch {
    // Non-Node projects and unreadable manifests fall back to the directory name.
  }
  return path.basename(path.resolve(projectCwd)) || fallbackTitle;
}

export function groupAvatarLabel(projectName: string): string {
  const normalized = projectName.trim();
  const characters = Array.from(normalized);
  const firstCharacter = characters[0];
  if (firstCharacter && isCjk(firstCharacter.codePointAt(0) ?? 0)) return characters.slice(0, 4).join("");
  return normalized.match(/[\p{L}\p{N}]+/u)?.[0] || "?";
}

export function generateGroupAvatarPng(projectName: string, projectCwd?: string): Uint8Array {
  const seed = projectCwd ? path.resolve(projectCwd) : projectName;
  const hash = createHash("sha256").update(seed).digest();
  const svg = identiconAvatarSvg(groupAvatarLabel(projectName), choosePalette(hash[0] ?? 0), hash);
  return new Resvg(svg, {
    fitTo: { mode: "width", value: AVATAR_SIZE },
    font: { loadSystemFonts: true },
  }).render().asPng();
}

function identiconAvatarSvg(label: string, colors: AvatarPalette, bytes: Buffer): string {
  const dots: string[] = [];
  const cell = 62;
  const start = 101;
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (((bytes[1 + row * 3 + column] ?? 0) & 1) === 0) continue;
      for (const mirrored of new Set([column, 4 - column])) {
        const color = (row + column) % 3 === 0 ? colors.accent : colors.primary;
        dots.push(`<circle cx="${start + mirrored * cell + cell / 2}" cy="${start + row * cell + cell / 2}" r="25" fill="${color}"/>`);
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" viewBox="0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}">
  <circle cx="256" cy="256" r="240" fill="${colors.dark}"/>
  ${dots.join("\n  ")}
  <rect x="54" y="184" width="404" height="144" rx="52" fill="${colors.dark}"/>
  ${centeredText(label, colors.light)}
</svg>`;
}

function centeredText(text: string, color: string): string {
  const visualWidth = Math.max(1, Array.from(text).reduce(
    (width, character) => width + (isCjk(character.codePointAt(0) ?? 0) ? 1 : 0.62),
    0,
  ));
  const fontSize = Math.max(34, Math.min(144, 400 / visualWidth));
  return `<text x="256" y="274" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-family="Inter, Segoe UI, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="700">${escapeXml(text)}</text>`;
}

function choosePalette(seed: number): AvatarPalette {
  const palettes: AvatarPalette[] = [
    { primary: "#246BFD", accent: "#20D5E8", light: "#FFFFFF", dark: "#10223C" },
    { primary: "#7657FF", accent: "#E75BFF", light: "#FFFFFF", dark: "#24153F" },
    { primary: "#00A884", accent: "#5CE1B9", light: "#FFFFFF", dark: "#123B36" },
    { primary: "#F26B38", accent: "#FFB14A", light: "#FFFFFF", dark: "#432418" },
  ];
  return palettes[seed % palettes.length]!;
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
