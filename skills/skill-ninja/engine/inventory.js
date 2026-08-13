// The cached-inventory builder for `skill-ninja init`.
//
// init analyzes the machine: it walks the configured scopes (agent roots,
// vaults, project dirs), discovers every Skill (a SKILL.md), detects
// version/provenance from frontmatter where present, records broken symlinks,
// and writes a cached inventory at ~/.skill-ninja/inventory.json.
//
// The cache is the data layer `status` / `doctor` (later tickets) read. It is
// regenerated wholesale on every init — there is no manually-maintained catalog
// (SPEC.md, "No anti-patterns"; CONTEXT.md: Skill, Agent root, Tool asymmetry,
// Provenance).
//
// Inventory schema + skill-discovery rule: docs/adr/0003-cached-inventory-and-discovery.md

import { readdir, stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import { loadConfig } from "./config.js";
import { agentRoot } from "./agents.js";

const CONFIG_DIR = ".skill-ninja";
const INVENTORY_FILE = "inventory.json";

// Directories never descended into during a scan (never skills, often huge).
const SKIP_DIRS = new Set([".git", "node_modules"]);

export function inventoryPath(home = homedir()) {
  return join(home, CONFIG_DIR, INVENTORY_FILE);
}

// --- frontmatter -------------------------------------------------------------

/**
 * Parse YAML-ish frontmatter at the top of a SKILL.md (delimited by `---`).
 * Minimal: top-level `key: value` pairs plus a single nested `provenance:`
 * object (2-space-indented children). Unknown keys are kept in the returned
 * object (the `name` field is used for skill naming). Returns {} when there is
 * no parseable frontmatter. Never throws.
 */
export function parseFrontmatter(text) {
  const result = {};
  if (typeof text !== "string" || !text.startsWith("---")) return result;

  const lines = text.split(/\r?\n/);
  // Opening fence must be on its own line.
  if (lines[0].trim() !== "---") return result;
  const closeIdx = lines.indexOf("---", 1);
  if (closeIdx === -1) return result;

  const fm = lines.slice(1, closeIdx);
  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
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

    // Nested object: collect following indented `key: value` lines.
    if (val.trim() === "" && fm[i + 1] !== undefined && /^\s{1,}\S/.test(fm[i + 1])) {
      const obj = {};
      i += 1;
      while (i < fm.length && /^\s{2,}\S/.test(fm[i])) {
        const sub = fm[i].match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (sub) obj[sub[1]] = coerce(sub[2]);
        i += 1;
      }
      result[key] = obj;
      continue;
    }

    result[key] = coerce(val);
    i += 1;
  }
  return result;
}

// Coerce a raw YAML-ish scalar to null / string. Quotes stripped; empty / null
// / ~ become null. Numbers/dates are left as strings (versions like "1.0" stay
// text; callers that need semantics can parse later).
function coerce(raw) {
  let v = String(raw).trim();
  if (v === "" || v === "null" || v === "~" || v === "Null" || v === "NULL") return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

// --- discovery ---------------------------------------------------------------

/**
 * Walk a scope's tree, collecting skill occurrences and broken symlinks.
 *
 * Discovery rule (ADR-0003): a directory containing a SKILL.md is a skill — it
 * is recorded and NOT descended into (its subdirs are bundled assets). Otherwise
 * the walk descends into subdirectories. Broken symlinks are recorded, never
 * raised. `lstat` detects symlinks; following the link (`stat`) detects
 * brokenness via ENOENT.
 */
async function scanScope(scope, rootPath, out) {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (err) {
    // A scope whose root is missing / unreadable contributes nothing.
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return;
    throw err;
  }

  // Does this directory itself contain a SKILL.md?
  const skillEntry = entries.find((e) => e.name === "SKILL.md");
  if (skillEntry) {
    const skillFile = join(rootPath, "SKILL.md");
    let resolved;
    try {
      resolved = await stat(skillFile); // follows symlinks
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // SKILL.md is a broken symlink — record and keep scanning siblings.
        out.broken.push({ path: skillFile, scope });
        return;
      }
      throw err;
    }
    if (resolved.isFile()) {
      out.skills.push(await describeSkill(skillFile, rootPath, scope));
      return; // do not descend — subdirs are this skill's bundled assets
    }
  }

  // No skill here: descend into subdirectories, recording broken symlinks.
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(rootPath, entry.name);

    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = await stat(full); // follows the link
      } catch (err) {
        if (err && err.code === "ENOENT") {
          out.broken.push({ path: full, scope });
          continue;
        }
        throw err;
      }
      if (target.isDirectory()) {
        await scanScope(scope, full, out);
      }
      // A symlink to a file that is not SKILL.md is irrelevant to discovery.
      continue;
    }

    if (entry.isDirectory()) {
      await scanScope(scope, full, out);
    }
  }
}

// Build one skill occurrence entry, parsing frontmatter for version/provenance.
async function describeSkill(skillFile, skillDir, scope) {
  let frontmatter = {};
  try {
    const text = await readFile(skillFile, "utf8");
    frontmatter = parseFrontmatter(text);
  } catch {
    frontmatter = {};
  }

  const name = (typeof frontmatter.name === "string" && frontmatter.name) || basename(skillDir);
  return {
    name,
    file: skillFile,
    dir: skillDir,
    scope,
    version: frontmatter.version ?? null,
    updated: frontmatter.updated ?? null,
    provenance: frontmatter.provenance ?? null,
  };
}

// --- orchestration -----------------------------------------------------------

function agentScopes(config, home) {
  const scopes = [];
  for (const key of config.agents) {
    const root = agentRoot(key, home);
    if (root) scopes.push({ kind: "agent", ref: key, root });
  }
  return scopes;
}

function pathScopes(kind, paths) {
  return paths.map((p) => ({ kind, ref: p, root: p }));
}

/**
 * Load config and scan every configured scope. Returns the inventory object
 * (without writing it). One entry per physical skill occurrence; broken
 * symlinks recorded distinctly. Never throws on a malformed SKILL.md.
 *
 * @param {string} [home] $HOME to resolve from.
 * @returns {Promise<object>} The inventory object (ADR-0003 schema).
 */
export async function buildInventory(home = homedir()) {
  const config = await loadConfig(home);

  const scopes = [
    ...agentScopes(config, home),
    ...pathScopes("vault", config.vaults),
    ...pathScopes("project", config.projects),
  ];

  const out = { skills: [], broken: [] };
  for (const scope of scopes) {
    await scanScope(scope, scope.root, out);
  }

  return finalizeInventory(scopes, out);
}

function finalizeInventory(scopes, out) {
  const byScope = {};
  for (const s of out.skills) {
    const key = `${s.scope.kind}:${s.scope.ref}`;
    byScope[key] = (byScope[key] ?? 0) + 1;
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      skills: out.skills.length,
      broken: out.broken.length,
      scopes: scopes.length,
      byScope,
    },
    skills: out.skills,
    broken: out.broken,
  };
}

/**
 * Write the inventory cache to ~/.skill-ninja/inventory.json (overwriting any
 * existing file). Returns the absolute path written.
 */
export async function writeInventory(inventory, home = homedir()) {
  const dir = join(home, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const path = inventoryPath(home);
  await writeFile(path, JSON.stringify(inventory, null, 2) + "\n", "utf8");
  return path;
}
