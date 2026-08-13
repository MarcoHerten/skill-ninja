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
 * @returns {Promise<{store: string|null, agents: string[], vaults: string[]}>}
 *   Rejects with an ENOENT-shaped error if the config file is missing.
 */
export async function loadConfig(home = homedir()) {
  const raw = await readFile(configPath(home), "utf8");
  return normalizeConfig(JSON.parse(raw), home);
}

export function normalizeConfig(parsed, home) {
  const agents = Array.isArray(parsed.agents)
    ? parsed.agents.filter((a) => typeof a === "string")
    : [];
  const vaults = Array.isArray(parsed.vaults)
    ? parsed.vaults.filter((v) => typeof v === "string").map((v) => expandTilde(v, home))
    : [];
  return {
    store: typeof parsed.store === "string" ? expandTilde(parsed.store, home) : null,
    agents,
    vaults,
  };
}
