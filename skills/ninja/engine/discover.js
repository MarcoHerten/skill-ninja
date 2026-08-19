// init's discovery + seeding phase (ADR-0008). On a fresh machine `init` needs no
// pre-existing config: it probes for installed agents, reads Obsidian's vault
// registry, seeds ~/.skill-ninja/config.json, creates the canonical store
// (`git init`), then scans. Re-running re-discovers and re-seeds — this is how
// config gets edited (there is no `config set` DSL). First run works without a
// remote. (CONTEXT.md: Agent root, Scan root, canonical store.)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";

import { discoverAgents } from "./agents.js";
import { normalizeCategories, normalizeNameLists } from "./config.js";
import { tryCommit } from "./git.js";

const CONFIG_DIR = ".skill-ninja";
const CONFIG_FILE = "config.json";
const STORE_DEFAULT = "skill-ninja-store";

/** The default canonical store path: ~/skill-ninja-store — visible in $HOME (ADR-0016). */
export function defaultStore(home) {
  return join(home, STORE_DEFAULT);
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
 * Resolve an `init --store` value (ADR-0016): a value with no path separators
 * is a bare name resolved under $HOME (`skill-vault` -> `~/skill-vault`); any
 * other value is a filesystem path — `~` expanded against $HOME, absolute or
 * relative as given.
 * @param {string} value
 * @param {string} home
 * @returns {string} The resolved store path.
 */
export function resolveStoreArg(value, home) {
  if (!value.includes("/") && !value.includes("\\")) return join(home, value);
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

// The seed README every freshly created store receives (ADR-0016): a fixed
// template — only the store name is interpolated (the engine never drafts
// editorial prose). One line what this repo is, a keep-it-private hint.
function seedReadme(store) {
  const name = basename(store);
  return (
    `# ${name}\n\n` +
    "This repository is the Skill Ninja canonical store: it holds the personal\n" +
    "skills Skill Ninja manages, and its git history is the per-skill change log\n" +
    "(add, ingest --apply, cat assign, availability switches).\n\n" +
    "Keep this repository private — personal skills can carry private context.\n"
  );
}

/**
 * Create the canonical store directory and `git init` it (idempotent). The
 * private remote is configured separately; the first run works with no remote.
 * (ADR-0007/0008.) A store created fresh is additionally seeded (ADR-0016): a
 * short README.md plus an initial `init store` commit, so the repo is
 * presentable the moment it lands on GitHub. An existing directory is never
 * seeded, committed, or modified beyond `git init` when it has no `.git`.
 * @param {string} store Absolute store path.
 * @returns {Promise<string>} The store path.
 */
export async function ensureStore(store) {
  const existed = existsSync(store);
  await mkdir(store, { recursive: true });
  if (!existsSync(join(store, ".git"))) {
    try {
      execFileSync("git", ["init", "-q", store], { stdio: "ignore" });
    } catch {
      // git unavailable — the store is still usable; versioning just won't run.
    }
  }
  if (!existed) {
    await writeFile(join(store, "README.md"), seedReadme(store), "utf8");
    // Best-effort initial commit; without git the README simply stays uncommitted.
    tryCommit(store, ["README.md"], "init store");
  }
  return store;
}

/**
 * Build the config to seed, merging discovery with any pre-existing config.
 *
 * Discovery is authoritative on a fresh machine; once a config exists, its
 * choices are preserved so the user's includes/excludes stick (re-running does
 * not clobber hand edits). Agents and vaults fall back to detection when the
 * existing config has none; projects are user-only (none detected). An
 * explicit `init --store` (ADR-0016) overrides the store for this run and is
 * what gets persisted.
 *
 * @param {string} home
 * @param {string|null} [storeOverride] Resolved store path from `--store`, or null.
 * @returns {Promise<{store:string, agents:string[], vaults:string[], projects:string[]}>}
 */
export async function bootstrapConfig(home, storeOverride = null) {
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
      storeOverride ??
      (typeof existing.store === "string" && existing.store ? existing.store : defaultStore(home)),
    agents: has(existing.agents) ? existing.agents : discoveredAgents,
    vaults: has(existing.vaults) ? existing.vaults : discoveredVaults,
    projects: Array.isArray(existing.projects) ? existing.projects : [],
    // The category vocabulary (Issue #10) is user-only — never detected, and a
    // hand-edited list survives re-seeding like `projects` does (normalized by
    // the shared rule in config.js, including an explicitly empty list).
    categories: normalizeCategories(existing.categories),
    // ADR-0014: the ZCode-disable ledger is user-only machine state — carried
    // forward verbatim-through-normalization on re-seed, never detected and
    // never dropped. Collections and profiles no longer live here (ADR-0017
    // moved them store-side; `init` migrates any pre-v1.5 config data).
    zcode_disables: normalizeNameLists(existing.zcode_disables),
  };
}
