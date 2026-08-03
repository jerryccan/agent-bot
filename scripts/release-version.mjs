const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;

export function resolveNextVersion(currentVersion, requested = "alpha") {
  const current = parseReleaseVersion(currentVersion, "current package version");
  if (requested === "alpha") {
    if (current.alpha !== undefined) return formatVersion({ ...current, alpha: current.alpha + 1 });
    return formatVersion({ ...bumpVersion(current, "patch"), alpha: 0 });
  }
  if (requested === "stable") {
    return current.alpha === undefined
      ? formatVersion(bumpVersion(current, "patch"))
      : formatVersion({ ...current, alpha: undefined });
  }
  if (["patch", "minor", "major"].includes(requested)) {
    return formatVersion(bumpVersion(current, requested));
  }

  const exact = parseReleaseVersion(requested, "requested version");
  if (compareReleaseVersions(exact, current) <= 0) {
    throw new Error(`Requested version ${requested} must be newer than ${currentVersion}.`);
  }
  return requested;
}

export function parseReleaseVersion(version, label = "version") {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${label} must be a stable or alpha semantic version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { alpha: Number(match[4]) } : {}),
  };
}

export function isAlphaVersion(version) {
  return parseReleaseVersion(version).alpha !== undefined;
}

function bumpVersion(version, release) {
  if (release === "patch") {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
  if (release === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }
  return { major: version.major + 1, minor: 0, patch: 0 };
}

function compareReleaseVersions(left, right) {
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core;
  if (left.alpha === undefined && right.alpha === undefined) return 0;
  if (left.alpha === undefined) return 1;
  if (right.alpha === undefined) return -1;
  return left.alpha - right.alpha;
}

function formatVersion(version) {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.alpha === undefined ? core : `${core}-alpha.${version.alpha}`;
}
