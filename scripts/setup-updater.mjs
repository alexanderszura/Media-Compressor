#!/usr/bin/env node
// One-time setup for auto-updates.
//
//   npm run setup-updater
//
// 1. Creates an updater signing key pair (kept OUTSIDE the repo, in ~/.tauri/).
// 2. Writes the public key into src-tauri/tauri.conf.json.
// 3. If the GitHub CLI (`gh`) is installed and logged in, stores the private key
//    as the repository secrets the publish workflow needs. Otherwise it prints
//    what to add by hand.
//
// Keep the private key safe. If you lose it, already-installed copies of the app
// can't verify new updates, and users would have to reinstall manually once.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const keyPath = process.env.MC_UPDATER_KEY ?? join(homedir(), ".tauri", "media-compressor.key");
const password = process.env.MC_UPDATER_KEY_PASSWORD ?? "";

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", cwd: root, ...opts });
}

// 1. key pair
if (existsSync(keyPath) && existsSync(keyPath + ".pub")) {
  console.log(`✔ Using existing signing key: ${keyPath}`);
} else {
  if (!existsSync(join(root, "node_modules", "@tauri-apps", "cli"))) {
    console.error("✘ Run `npm install` first (the Tauri CLI is needed to create the key).");
    process.exit(1);
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  console.log(`• Generating signing key at ${keyPath} …`);
  // With --ci and no -p, the Tauri CLI uses an empty password. Don't pass an empty
  // "-p" value: on Windows the shell drops the empty argument and the CLI errors.
  const win = process.platform === "win32";
  const args = ["--no-install", "tauri", "signer", "generate", "--ci", "-w", win ? `"${keyPath}"` : keyPath];
  if (password) args.push("-p", win ? `"${password}"` : password);
  const r = spawnSync("npx", args, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    shell: win,
  });
  if (r.status !== 0) {
    console.error("✘ Key generation failed.");
    process.exit(1);
  }
}

// 2. public key -> tauri.conf.json
const pub = readFileSync(keyPath + ".pub", "utf8").trim();
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pub;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
console.log("✔ Public key written to src-tauri/tauri.conf.json (commit this file).");

// 3. GitHub secrets
const privateKey = readFileSync(keyPath, "utf8").trim();
let ghOk = false;
try {
  run("gh auth status");
  ghOk = true;
} catch {
  /* gh missing or not logged in */
}

if (ghOk) {
  try {
    run("gh secret set TAURI_SIGNING_PRIVATE_KEY", { input: privateKey });
    run("gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD", { input: password });
    console.log("✔ Repository secrets TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD set via gh.");
  } catch (e) {
    ghOk = false;
    console.warn("! Couldn't set secrets with gh:", String(e.stderr || e.message).trim());
  }
}
if (!ghOk) {
  console.log(`
Add these on GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret:

  TAURI_SIGNING_PRIVATE_KEY           = the full contents of ${keyPath}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  = ${password ? "the password you set in MC_UPDATER_KEY_PASSWORD" : "(leave empty)"}
`);
}

console.log(`Done. Back up ${keyPath} somewhere safe, and never commit it.`);
