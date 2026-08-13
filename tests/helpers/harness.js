// Fixture test harness for the black-box CLI seam (see docs/adr/0001-node-cli-fixture-seam.md).
//
// Build a sandboxed fake $HOME with configured agent roots and an Obsidian vault,
// then run the Skill Ninja engine CLI against it and capture stdout / exit code.
// Tests assert only on the CLI's stdout and the resulting filesystem state —
// never on engine internals — so this harness imports no engine code.

import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
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
    // reuse. (ADR-0003: scan roots scanned.)
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
 * Plant a **duplicate**: the same Skill (by name) as real directories in several
 * locations — the tool-asymmetry mess `doctor` dedups. Each location gets its own
 * real (non-symlink) SKILL.md so they classify as "loose" copies. (Issue #6.)
 *
 * @param {string} home The fake $HOME.
 * @param {string} name The shared skill name (written into each SKILL.md).
 * @param {string[]} dirRels Directories (relative to home) to plant the skill in.
 * @param {object} [opts] Passed through to `plantSkill` (body / frontmatter).
 * @returns {Promise<Array<{file:string, dir:string, name:string}>>}
 */
export async function plantDuplicate(home, name, dirRels, { body = "# A skill\n", frontmatter = null } = {}) {
  const fm = frontmatter ?? { name };
  const planted = [];
  for (const rel of dirRels) {
    planted.push(await plantSkill(home, rel, { frontmatter: fm, body }));
  }
  return planted;
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

// --- add-command fixtures ----------------------------------------------------
// Helpers for the `add` ticket (Issue #3): turn the canonical store into a git
// repo (so the engine's "commit if configured" path is exercisable offline),
// read back a stored Skill, and parse its stamped frontmatter. As with the
// planters above, these import no engine code — they keep a local, intentionally
// duplicated frontmatter reader so tests stay a black box (ADR-0001).

/**
 * Resolve the canonical store path from a planted config (mirrors the engine's
 * `~`-expansion). Defaults to the DEFAULT_CONFIG store.
 */
export function storePath(home, store = DEFAULT_CONFIG.store) {
  return expandTilde(store, home);
}

/**
 * `git init` the canonical store and give it a default identity, so the engine's
 * "commit if the store is a git repo" path runs without network. Returns the
 * absolute store path. Used by the git-commit slice (Slice G) and the repo-source
 * slice (Slice F).
 */
export function makeStoreGitRepo(home, store = DEFAULT_CONFIG.store) {
  const dir = storePath(home, store);
  // mkdir -p the store first; git init needs an existing (or creatable) dir.
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", dir, "config", "user.name", "Test User"],
    { stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["-C", dir, "config", "user.email", "test@example.com"],
    { stdio: "ignore" },
  );
  return dir;
}

/**
 * Create a local git repo (with one committed SKILL.md) at `dest` and return its
 * path. Used to exercise the `add <repo>` git-clone code path offline: the path
 * ends in `.git` so the engine's repo-source detector clones it. `dest` should
 * be absolute.
 */
export function makeLocalSkillRepo(dest, { name = "repo-skill", body = "# From repo\n" } = {}) {
  execFileSync("git", ["init", "-q", dest], { stdio: "ignore" });
  execFileSync("git", ["-C", dest, "config", "user.name", "Repo Author"], { stdio: "ignore" });
  execFileSync("git", ["-C", dest, "config", "user.email", "repo@example.com"], { stdio: "ignore" });
  writeFileSync(join(dest, "SKILL.md"), `---\nname: ${name}\n---\n\n${body}`, "utf8");
  execFileSync("git", ["-C", dest, "add", "SKILL.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", dest, "commit", "-q", "-m", "init"], { stdio: "ignore" });
  return dest;
}

// Synchronous file write for fixture setup (the repo helper runs before any
// async test step).
import { writeFileSync } from "node:fs";

/**
 * Read the stored Skill's SKILL.md (the canonical copy in the store).
 */
export async function readStoredSkill(home, name, store = DEFAULT_CONFIG.store) {
  return readFile(join(storePath(home, store), name, "SKILL.md"), "utf8");
}

/**
 * Minimal frontmatter reader: parse the `---`-delimited block at the top of a
 * SKILL.md into a flat-ish object (top-level scalars + a nested `provenance`
 * object). Local duplicate of the engine's parser so tests stay black-box.
 * Returns {} when there is no frontmatter.
 */
export function parseStamps(text) {
  const out = {};
  if (typeof text !== "string" || !text.startsWith("---")) return out;
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return out;
  const close = lines.indexOf("---", 1);
  if (close === -1) return out;
  const fm = lines.slice(1, close);
  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const val = m[2];
    if (val.trim() === "" && fm[i + 1] !== undefined && /^\s{2,}\S/.test(fm[i + 1])) {
      const obj = {};
      i += 1;
      while (i < fm.length && /^\s{2,}\S/.test(fm[i])) {
        const sub = fm[i].match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (sub) {
          let v = sub[2].trim();
          if (v === "null" || v === "~") v = null;
          else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          obj[sub[1]] = v;
        }
        i += 1;
      }
      out[key] = obj;
      continue;
    }
    let v = val.trim();
    if (v === "null" || v === "~") v = null;
    else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[key] = v;
    i += 1;
  }
  return out;
}
