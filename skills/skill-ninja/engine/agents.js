// The agent-root model: which subdirectory under $HOME each supported coding
// agent reads skills from. Skill Ninja abstracts over tool asymmetry by mapping
// each logical agent to its root under the user's $HOME.
// (CONTEXT.md: Agent root, Tool asymmetry.)
import { join } from "node:path";

export const AGENT_ROOTS = {
  claude: ".claude/skills",
  zcode: ".zcode/skills",
  generic: ".agents/skills",
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
