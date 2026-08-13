// Fixture test harness for the black-box CLI seam (see docs/adr/0001-node-cli-fixture-seam.md).
//
// Build a sandboxed fake $HOME with configured agent roots and an Obsidian vault,
// then run the Skill Ninja engine CLI against it and capture stdout / exit code.
// Tests assert only on the CLI's stdout and the resulting filesystem state —
// never on engine internals — so this harness imports no engine code.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
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
// `projects` is the project-working-directories field (ADR-0003); empty by
// default so earlier tests are unaffected.
export const DEFAULT_CONFIG = {
  store: "~/.skill-ninja/store",
  agents: ["claude", "zcode"],
  vaults: ["~/Documents/Obsidian Vault"],
  projects: [],
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
    // Plant the configured agent roots, vaults, and project dirs so the sandbox
    // is a realistic skill landscape that later tickets (init / status / doctor)
    // reuse. (ADR-0003: scopes scanned.)
    for (const key of config.agents ?? []) {
      const sub = AGENT_ROOTS[key];
      if (sub) await mkdir(join(home, sub), { recursive: true });
    }
    for (const vault of config.vaults ?? []) {
      await mkdir(expandTilde(vault, home), { recursive: true });
    }
    for (const project of config.projects ?? []) {
      await mkdir(expandTilde(project, home), { recursive: true });
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

// --- Skill / fixture planters -------------------------------------------------
// Reusable helpers for planting the skill landscape a test wants to scan. They
// write plain files / symlinks; they import no engine code, keeping the test a
// black box (ADR-0001).

// Serialize a small frontmatter object to YAML-ish lines the engine parser reads.
// Nested objects become 2-space-indented children (used for `provenance`).
function serializeFrontmatter(obj, indent = "") {
  let out = "";
  for (const [key, val] of Object.entries(obj)) {
    if (val !== null && typeof val === "object") {
      out += `${indent}${key}:\n`;
      out += serializeFrontmatter(val, indent + "  ");
    } else if (val === null || val === undefined) {
      out += `${indent}${key}: null\n`;
    } else {
      out += `${indent}${key}: ${val}\n`;
    }
  }
  return out;
}

/**
 * Plant a Skill (a SKILL.md, optionally inside a directory) under the sandbox.
 *
 * @param {string} home The fake $HOME.
 * @param {string} dirRel Directory (relative to home) that will hold SKILL.md;
 *   created recursively. The skill name defaults to this directory's basename.
 * @param {object} [opts]
 * @param {object|null} [opts.frontmatter] Frontmatter object written at the top
 *   of SKILL.md (e.g. `{ name, version, updated, provenance: {...} }`).
 * @param {string} [opts.body] Markdown body after the frontmatter.
 * @returns {Promise<{file: string, dir: string, name: string}>} Absolute paths
 *   plus the skill name (frontmatter `name`, else the directory basename).
 */
export async function plantSkill(home, dirRel, { frontmatter = null, body = "# A skill\n" } = {}) {
  const dir = join(home, dirRel);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  let content = "";
  if (frontmatter) {
    content += "---\n" + serializeFrontmatter(frontmatter) + "---\n\n";
  }
  content += body;
  await writeFile(file, content, "utf8");
  const name = (frontmatter && frontmatter.name) || basename(dir);
  return { file, dir, name };
}

/**
 * Plant a broken (dangling) symlink under the sandbox.
 *
 * @param {string} home The fake $HOME.
 * @param {string} relPath The symlink path (relative to home). Its parent
 *   directory is created; the link points at a nonexistent target.
 * @returns {Promise<{link: string}>} Absolute path of the planted symlink.
 */
export async function plantBrokenSymlink(home, relPath) {
  const link = join(home, relPath);
  await mkdir(dirname(link), { recursive: true });
  const target = join(home, relPath + ".missing-target"); // deliberately absent
  await symlink(target, link);
  return { link };
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
