// Builds the updater manifest (latest.json) from a GitHub release's assets.
// Used by .github/workflows/publish.yml once every platform build has uploaded
// its installers + .sig files, so the manifest is written exactly once.
//
// Usage: node scripts/make-latest-json.mjs <release.json> <sig-dir>
//   release.json  output of `gh release view <tag> --json tagName,body,assets`
//   sig-dir       folder holding the release's downloaded *.sig files
// Env: GITHUB_REPOSITORY (owner/repo). Writes the manifest to stdout.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [releaseFile, sigDir] = process.argv.slice(2);
if (!releaseFile || !sigDir) {
  console.error("usage: make-latest-json.mjs <release.json> <sig-dir>");
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("GITHUB_REPOSITORY is not set");
  process.exit(2);
}

const release = JSON.parse(readFileSync(releaseFile, "utf8"));
const tag = release.tagName;
const names = new Set(release.assets.map((a) => a.name));
const url = (name) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

// Updater key -> asset name pattern. The plugin looks for "<os>-<arch>-<installer>"
// first and falls back to "<os>-<arch>".
const RULES = [
  ["windows-x86_64-msi", /\.msi$/i],
  ["windows-x86_64-nsis", /-setup\.exe$/i],
  ["darwin-aarch64-app", /aarch64\.app\.tar\.gz$/i],
  ["darwin-x86_64-app", /(x64|x86_64)\.app\.tar\.gz$/i],
  ["linux-x86_64-appimage", /\.AppImage$/],
  ["linux-x86_64-deb", /\.deb$/i],
  ["linux-x86_64-rpm", /\.rpm$/i],
];
const FALLBACKS = {
  "windows-x86_64": ["windows-x86_64-msi", "windows-x86_64-nsis"],
  "darwin-aarch64": ["darwin-aarch64-app"],
  "darwin-x86_64": ["darwin-x86_64-app"],
  "linux-x86_64": ["linux-x86_64-appimage"],
};

const platforms = {};
for (const [key, pattern] of RULES) {
  const asset = [...names].find((n) => pattern.test(n) && names.has(`${n}.sig`));
  if (!asset) continue;
  const signature = readFileSync(join(sigDir, `${asset}.sig`), "utf8").trim();
  platforms[key] = { signature, url: url(asset) };
}
for (const [key, candidates] of Object.entries(FALLBACKS)) {
  const found = candidates.find((c) => platforms[c]);
  if (found) platforms[key] = platforms[found];
  else console.error(`::warning::No signed updater bundle found for ${key}`);
}
if (!Object.keys(platforms).length) {
  console.error("::error::No signed updater bundles found on the release");
  process.exit(1);
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: release.body ?? "",
  pub_date: new Date().toISOString(),
  platforms,
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
