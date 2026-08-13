// Fixture test harness for the black-box CLI seam (see docs/adr/0001-node-cli-fixture-seam.md).
//
// Build a sandboxed fake $HOME with configured agent roots and an Obsidian vault,
// then run the Skill Ninja engine CLI against it and capture stdout / exit code.
// Tests assert only on the CLI's stdout and the resulting filesystem state —
// never on engine internals — so this harness imports no engine code.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the engine CLI entry. Tests always invoke it through runCli().
export const ENGINE_PATH = fileURLToPath(
  new URL("../../skills/skill-ninja/engine/cli.js", import.meta.url),
);

// The agent-root model: which subdirectory under $HOME each supported coding
// agent reads skills from. This mirrors the engine's documented model
// (skills/skill-ninja/engine/agents.js) — kept as a local copy here so the test
// stays a black box. See CONTEXT.md: Agent root, Tool asymmetry.
const AGENT_ROOTS = {
  claude: ".claude/skills",
  zcode: ".zcode/skills",
  generic: ".agents/skills",
};

// Default config planted when a test does not supply one. Paths use the `~`
// convention so the engine's $HOME-relative resolution is exercised.
export const DEFAULT_CONFIG = {
  store: "~/.skill-ninja/store",
  agents: ["claude", "zcode"],
  vaults: ["~/Documents/Obsidian Vault"],
};

function expandTilde(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Create a sandboxed fake $HOME.
 *
 * @param {object} [options]
 * @param {object|null} [options.config] Config object to write at
 *   `~/.skill-ninja/config.json` (defaults to DEFAULT_CONFIG). Pass `null` to
 *   create a $HOME with no config file.
 * @returns {Promise<{home: string, configPath: string, cleanup: () => Promise<void>}>}
 */
export async function createSandbox({ config = DEFAULT_CONFIG } = {}) {
  const home = await mkdtemp(join(tmpdir(), "skill-ninja-"));

  if (config !== null) {
    await mkdir(join(home, ".skill-ninja"), { recursive: true });
    await writeFile(
      join(home, ".skill-ninja", "config.json"),
      JSON.stringify(config, null, 2) + "\n",
      "utf8",
    );
    // Plant the configured agent roots and vaults so the sandbox is a realistic
    // skill landscape that later tickets (init / status / doctor) reuse.
    for (const key of config.agents ?? []) {
      const sub = AGENT_ROOTS[key];
      if (sub) await mkdir(join(home, sub), { recursive: true });
    }
    for (const vault of config.vaults ?? []) {
      await mkdir(expandTilde(vault, home), { recursive: true });
    }
  }

  return {
    home,
    configPath: join(home, ".skill-ninja", "config.json"),
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/**
 * Run the Skill Ninja engine CLI against a fake $HOME and capture its output.
 *
 * @param {string} home The fake $HOME to run inside.
 * @param {string[]} [args] CLI args (e.g. `["config", "show"]`).
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number | null}>}
 */
export function runCli(home, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENGINE_PATH, ...args], {
      env: { ...process.env, HOME: home, USER: "test" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: stderr + String(error), exitCode: null });
    });
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}
