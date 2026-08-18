// Config loader. Reads Skill Ninja's configuration from a defined location under
// the user's $HOME: ~/.skill-ninja/config.json. Paths in the file may use a
// leading "~", expanded against $HOME. os.homedir() honours $HOME on POSIX, so
// tests steer the loader at a fake $HOME simply by setting the env var.
import { readFile } from "node:fs/promises";
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
  };
}
