// init's discovery + seeding phase (ADR-0008). On a fresh machine `init` needs no
// pre-existing config: it probes for installed agents, reads Obsidian's vault
// registry, seeds ~/.skill-ninja/config.json, creates the canonical store
// (`git init`), then scans. Re-running re-discovers and re-seeds — this is how
// config gets edited (there is no `config set` DSL). First run works without a
// remote. (CONTEXT.md: Agent root, Scan root, canonical store.)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { discoverAgents } from "./agents.js";

const CONFIG_DIR = ".skill-ninja";
const CONFIG_FILE = "config.json";
const STORE_DEFAULT = "store";

/** The default canonical store path: ~/.skill-ninja/store. */
export function defaultStore(home) {
  return join(home, CONFIG_DIR, STORE_DEFAULT);
}

// Obsidian's vault-registry path by platform (ADR-0008).
function obsidianConfigPath(home) {
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/obsidian/obsidian.json");
  }
  if (process.platform === "win32") {
    return join(home, "AppData/Roaming/obsidian/obsidian.json"); // %APPDATA%
  }
  return join(home, ".config/obsidian/obsidian.json"); // linux
}

/**
 * Read Obsidian's vault registry; each existing `vaults[*].path` is a scan root.
 * Absent / unreadable / malformed file => no vaults (graceful). Returns absolute
 * vault paths that currently exist on disk.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function discoverVaults(home) {
  let raw;
  try {
    raw = await readFile(obsidianConfigPath(home), "utf8");
  } catch {
    return []; // Obsidian not installed / never opened a vault.
  }
  try {
    const parsed = JSON.parse(raw);
    const vaults = parsed && typeof parsed === "object" ? parsed.vaults : null;
    if (!vaults || typeof vaults !== "object") return [];
    const paths = [];
    for (const v of Object.values(vaults)) {
      if (v && typeof v.path === "string" && existsSync(v.path)) paths.push(v.path);
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Write ~/.skill-ninja/config.json (the seed). Overwrites any existing file.
 * @param {string} home
 * @param {object} config The config object to write.
 * @returns {Promise<string>} The absolute config path written.
 */
export async function seedConfig(home, config) {
  const dir = join(home, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, CONFIG_FILE);
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Create the canonical store directory and `git init` it (idempotent). The
 * private remote is configured separately; the first run works with no remote.
 * (ADR-0007/0008.)
 * @param {string} store Absolute store path.
 * @returns {Promise<string>} The store path.
 */
export async function ensureStore(store) {
  await mkdir(store, { recursive: true });
  if (!existsSync(join(store, ".git"))) {
    try {
      execFileSync("git", ["init", "-q", store], { stdio: "ignore" });
    } catch {
      // git unavailable — the store is still usable; versioning just won't run.
    }
  }
  return store;
}

/**
 * Build the config to seed, merging discovery with any pre-existing config.
 *
 * Discovery is authoritative on a fresh machine; once a config exists, its
 * choices are preserved so the user's includes/excludes stick (re-running does
 * not clobber hand edits). Agents and vaults fall back to detection when the
 * existing config has none; projects are user-only (none detected).
 *
 * @param {string} home
 * @returns {Promise<{store:string, agents:string[], vaults:string[], projects:string[]}>}
 */
export async function bootstrapConfig(home) {
  const discoveredAgents = discoverAgents(home);
  const discoveredVaults = await discoverVaults(home);

  let existing = {};
  try {
    existing = JSON.parse(await readFile(join(home, CONFIG_DIR, CONFIG_FILE), "utf8"));
  } catch {
    existing = {}; // fresh machine — no config yet.
  }

  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  return {
    store:
      typeof existing.store === "string" && existing.store ? existing.store : defaultStore(home),
    agents: has(existing.agents) ? existing.agents : discoveredAgents,
    vaults: has(existing.vaults) ? existing.vaults : discoveredVaults,
    projects: Array.isArray(existing.projects) ? existing.projects : [],
    // The category vocabulary (Issue #10) is user-only — never detected, and a
    // hand-edited list survives re-seeding like `projects` does.
    categories: Array.isArray(existing.categories)
      ? existing.categories.filter((c) => typeof c === "string" && c.trim() !== "")
      : null,
  };
}
