// The agent-root model: which subdirectory under $HOME each supported coding
// agent reads skills from. Skill Ninja abstracts over tool asymmetry by mapping
// each logical agent to its root under the user's $HOME.
// (CONTEXT.md: Agent root, Tool asymmetry.)
//
// The map mirrors skills.sh's global-root conventions (ADR-0007/0008): each key
// is an agent family, the value its skills subdirectory under $HOME. Agents that
// share skills.sh's `.agents/skills` root (cline, cursor-project, opencode
// project-level, …) are represented once by the `agents` key — the existence-
// probe is over distinct roots, not every one of skills.sh's 76 aliases. `init`
// detects installed agents by existence-probing each root and seeds only those
// that exist (ADR-0008); the map is probed, not treated as a fixed active set.
import { join } from "node:path";
import { existsSync } from "node:fs";

export const AGENT_ROOTS = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  cursor: ".cursor/skills",
  gemini: ".gemini/skills",
  // Antigravity's roots are NOT the Gemini CLI root above, even though both
  // live under ~/.gemini. Since Antigravity 1.107 the IDE discovers global
  // customizations (skills included) under ~/.gemini/config — verified against
  // the language-server binary's discovery hierarchy; the ~/.gemini/antigravity/
  // skills path still cited by skills.sh and older blog posts is read by no
  // current version. The CLI keeps its own root (antigravity.google/docs/cli).
  antigravity: ".gemini/config/skills",
  "antigravity-cli": ".gemini/antigravity-cli/skills",
  copilot: ".copilot/skills",
  windsurf: ".codeium/windsurf/skills",
  roo: ".roo/skills",
  trae: ".trae/skills",
  zcode: ".zcode/skills",
  // Shared generic root: skills.sh routes several agents (cline, opencode at
  // project level, etc.) through ~/.agents/skills.
  agents: ".agents/skills",
  opencode: ".config/opencode/skills",
  goose: ".config/goose/skills",
};

/**
 * Resolve an agent's root directory under a given $HOME.
 * @param {string} key Agent key (e.g. "claude").
 * @param {string} home The $HOME to resolve against.
 * @returns {string|null} Absolute root path, or null if the agent is unknown.
 */
export function agentRoot(key, home) {
  const sub = AGENT_ROOTS[key];
  return sub ? join(home, sub) : null;
}

/**
 * Discover installed agents by existence-probe (ADR-0008). An agent counts as
 * installed when its root directory exists under $HOME. Returns the keys of
 * every installed agent, in AGENT_ROOTS declaration order.
 *
 * @param {string} home The $HOME to probe.
 * @returns {string[]} Installed agent keys (e.g. ["claude", "zcode"]).
 */
export function discoverAgents(home) {
  const installed = [];
  for (const [key, sub] of Object.entries(AGENT_ROOTS)) {
    if (existsSync(join(home, sub))) installed.push(key);
  }
  return installed;
}

// Plugin cache roots (ADR-0018): where each agent's plugin system unpacks
// plugins under $HOME. Plugins bundle skills in a `skills/` subtree — the
// layout the vendor-neutral Agent Plugins 1.0.0 spec standardized (steering
// committee: Amazon, Cursor, Microsoft, OpenAI, Vercel; Google joined 2026),
// and the pre-spec caches already use. The spec deliberately defines no
// install location, so this map holds the verified de-facto cache roots and
// grows as clients adopt. Only the CACHE tree is scanned — a sibling
// `marketplaces/` tree holds the same plugins again as source clones, and
// scanning both would count every bundled skill twice.
export const PLUGIN_ROOTS = {
  claude: ".claude/plugins/cache",
  zcode: ".zcode/cli/plugins/cache",
};

/**
 * Resolve an agent's plugin cache root under a given $HOME (ADR-0018).
 * @param {string} key Agent key (e.g. "claude").
 * @param {string} home The $HOME to resolve against.
 * @returns {string|null} Absolute plugin root path, or null if the agent has none.
 */
export function pluginRoot(key, home) {
  const sub = PLUGIN_ROOTS[key];
  return sub ? join(home, sub) : null;
}
