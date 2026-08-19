// Config loader. Reads Skill Ninja's configuration from a defined location under
// the user's $HOME: ~/.skill-ninja/config.json. Paths in the file may use a
// leading "~", expanded against $HOME. os.homedir() honours $HOME on POSIX, so
// tests steer the loader at a fake $HOME simply by setting the env var.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = ".skill-ninja";
const CONFIG_FILE = "config.json";

function configDir(home = homedir()) {
  return join(home, CONFIG_DIR);
}

export function configPath(home = homedir()) {
  return join(configDir(home), CONFIG_FILE);
}

// Expand a leading "~" to the given home. Absolute / relative paths pass through.
function expandTilde(p, home) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Load and normalize the config from ~/.skill-ninja/config.json.
 * @param {string} [home] $HOME to resolve from (defaults to os.homedir()).
 * @returns {Promise<{store: string|null, agents: string[], vaults: string[], projects: string[]}>}
 *   Rejects with an ENOENT-shaped error if the config file is missing.
 */
export async function loadConfig(home = homedir()) {
  const raw = await readFile(configPath(home), "utf8");
  return normalizeConfig(JSON.parse(raw), home);
}

// Normalize the category vocabulary (Issue #10): an array of non-empty
// strings, else null (= the engine defaults). Shared with `init`'s config
// seeding so a hand-edited list survives re-seeding unchanged — one rule, two
// callers. An explicitly configured array (even empty) is preserved as-is:
// it replaces the defaults wholesale (ADR-0013).
export function normalizeCategories(value) {
  return Array.isArray(value)
    ? value.filter((c) => typeof c === "string" && c.trim() !== "")
    : null;
}

// Normalize a map of name -> string[] (the ADR-0014 data shapes: `profiles`
// and the `zcode_disables` ledger). Non-array / empty members are dropped;
// non-string members are filtered. Always returns an object. Exported because
// `init`'s re-seeding carries both fields forward with the same rule
// (discover.js — the `categories` precedent).
export function normalizeNameLists(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [name, members] of Object.entries(value)) {
    if (!Array.isArray(members)) continue;
    const list = members.filter((m) => typeof m === "string" && m.trim() !== "");
    if (list.length > 0) out[name] = list;
  }
  return out;
}

export function normalizeConfig(parsed, home) {
  const agents = Array.isArray(parsed.agents)
    ? parsed.agents.filter((a) => typeof a === "string")
    : [];
  const expandStrings = (arr) =>
    Array.isArray(arr)
      ? arr.filter((v) => typeof v === "string").map((v) => expandTilde(v, home))
      : [];
  return {
    store: typeof parsed.store === "string" ? expandTilde(parsed.store, home) : null,
    agents,
    vaults: expandStrings(parsed.vaults),
    // Project working directories to scan for SKILL.md (ADR-0003).
    projects: expandStrings(parsed.projects),
    // The category vocabulary for `cat` / `page` (Issue #10). Null = the
    // engine defaults (DEFAULT_CATEGORIES in cat.js) — resolveVocabulary picks.
    categories: normalizeCategories(parsed.categories),
    // ADR-0014: named skill sets applied per project (`profile apply`), and the
    // ledger of ZCode-config disable entries Skill Ninja wrote itself (so `on`
    // removes only its own overrides, never the user's hand-set ones).
    // ADR-0015: named personal filters over the inventory (`cat @<name>`).
    profiles: normalizeNameLists(parsed.profiles),
    zcodeDisables: normalizeNameLists(parsed.zcode_disables),
    collections: normalizeNameLists(parsed.collections),
  };
}

/**
 * Read the raw config object (every key preserved, no normalization) — the
 * read side of the write paths that edit one field and must not drop the rest
 * (`profile save/forget`, the availability ledger). Returns null when the
 * config file does not exist; a malformed file still throws.
 */
export async function readRawConfig(home = homedir()) {
  try {
    return JSON.parse(await readFile(configPath(home), "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write the raw config object back to ~/.skill-ninja/config.json (2-space
 * JSON + trailing newline, the format `init` seeds).
 */
export async function writeRawConfig(home, obj) {
  await mkdir(configDir(home), { recursive: true });
  await writeFile(configPath(home), JSON.stringify(obj, null, 2) + "\n", "utf8");
}
