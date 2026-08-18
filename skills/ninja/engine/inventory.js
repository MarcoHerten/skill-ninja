// The cached-inventory builder for `ninja init`.
//
// init analyzes the machine: it walks the configured scan roots (agent roots,
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
// Vocabulary: each discovered location is a "scan root" (CONTEXT.md). In an
// earlier draft this was named `scope`; the rename is complete in code + schema.

import { readdir, stat, lstat, realpath, mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import { loadConfig } from "./config.js";
import { agentRoot } from "./agents.js";
import { bodyHash } from "./hash.js";

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
 * object (2-space-indented children), and YAML block scalars (`description:
 * >-` / `|` with chomping/indent indicators) — the style every longer
 * agent-activation description is written in. Unknown keys are kept in the
 * returned object (the `name` field is used for skill naming). Returns {} when
 * there is no parseable frontmatter. Never throws.
 */
// Block scalar headers: `>`, `|`, plus optional chomping (`-`/`+`) and explicit
// indentation indicators (`|2`, `>-2`, `>2-`). A plain scalar can never start
// with `>` or `|` unquoted, so this match is unambiguous.
const BLOCK_HEADER = /^([>|])[0-9+-]*$/;

/**
 * Read the indented content lines of a block scalar starting after
 * `lines[keyIdx]` (the `key: >-` header at indentation `keyIndent`) and return
 * the value plus the index of the first unconsumed line.
 *
 * Both styles collapse to ONE line (all whitespace runs become single spaces):
 * every field this parser models is one-line metadata — descriptions are the
 * catalog's one-liners (cat.js) and are re-serialized as quoted plain scalars
 * by `add`'s stamping — so the folded/literal distinction and chomping
 * indicators never change a stored value. The line break itself is preserved
 * as a space, which is YAML folding for the common all-nonempty-lines case.
 */
function readBlockScalar(lines, keyIdx, keyIndent) {
  const content = [];
  let i = keyIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    content.push(line);
  }
  // Blank lines before the first content line and after the last belong to the
  // surrounding node, not the block.
  while (content.length && content[0] === "") content.shift();
  while (content.length && content[content.length - 1] === "") content.pop();
  if (content.length === 0) return { value: null, next: i };
  const blockIndent = content[0].length - content[0].trimStart().length;
  const value = content.map((l) => l.slice(blockIndent)).join(" ").replace(/\s+/g, " ").trim();
  return { value: value === "" ? null : value, next: i };
}

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

    // Block scalar: the indented lines below the header are the value.
    if (BLOCK_HEADER.test(val.trim())) {
      const block = readBlockScalar(fm, i, line.length - line.trimStart().length);
      result[key] = block.value;
      i = block.next;
      continue;
    }

    // Nested object: collect following indented `key: value` lines.
    if (val.trim() === "" && fm[i + 1] !== undefined && /^\s{1,}\S/.test(fm[i + 1])) {
      const obj = {};
      i += 1;
      while (i < fm.length && /^\s{2,}\S/.test(fm[i])) {
        const sub = fm[i].match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (sub && BLOCK_HEADER.test(sub[2].trim())) {
          const nested = readBlockScalar(fm, i, fm[i].length - fm[i].trimStart().length);
          obj[sub[1]] = nested.value;
          i = nested.next;
        } else {
          if (sub) obj[sub[1]] = coerce(sub[2]);
          i += 1;
        }
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
 * Walk a scan root's tree, collecting skill occurrences and broken symlinks.
 *
 * Discovery rule (ADR-0003): a directory containing a SKILL.md is a skill — it
 * is recorded and NOT descended into (its subdirs are bundled assets). Otherwise
 * the walk descends into subdirectories. Broken symlinks are recorded, never
 * raised. `lstat` detects symlinks; following the link (`stat`) detects
 * brokenness via ENOENT.
 *
 * @param {{kind:string, ref:string, root:string}} scanRoot The scan-root descriptor.
 * @param {string} rootPath The directory to walk (starts at scanRoot.root).
 * @param {object} attribution skills.sh lockfile attribution for this root
 *   (name -> {source, computedHash}); empty when no lockfile applies.
 * @param {object} out Accumulator: `{ skills: [], broken: [] }`.
 */
async function scanRootTree(scanRoot, rootPath, attribution, out) {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (err) {
    // A scan root whose root is missing / unreadable contributes nothing.
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
        out.broken.push({ path: skillFile, scanRoot });
        return;
      }
      throw err;
    }
    if (resolved.isFile()) {
      out.skills.push(await describeSkill(skillFile, rootPath, scanRoot, attribution));
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
          out.broken.push({ path: full, scanRoot });
          continue;
        }
        throw err;
      }
      if (target.isDirectory()) {
        await scanRootTree(scanRoot, full, attribution, out);
      }
      // A symlink to a file that is not SKILL.md is irrelevant to discovery.
      continue;
    }

    if (entry.isDirectory()) {
      await scanRootTree(scanRoot, full, attribution, out);
    }
  }
}

// Build one skill occurrence entry, parsing frontmatter for version/provenance
// and computing the content hash (ADR-0005 body hash; CONTEXT.md "Duplicate" —
// the hash is the secondary identity signal that catches the same skill living
// under a different name). `attribution` carries skills.sh lockfile data
// (ADR-0007/0008): when the skill name is recorded in a lockfile, the occurrence
// is tagged External. The stored scanRoot is kept lean (no attribution payload).
//
// Symlink awareness (schema v2): each occurrence records whether its directory
// is a symlink and its resolved (realpath) location. This is what lets `status`
// tell a healthy linked spread — one canonical copy plus links into it, whether
// those links point into the store (`add`) or into one of the agent roots
// (skills.sh's install pattern) — apart from a loose-copy duplicate, and lets
// `doctor` count independent content copies.
async function describeSkill(skillFile, skillDir, scanRoot, attribution) {
  let frontmatter = {};
  let text = "";
  try {
    text = await readFile(skillFile, "utf8");
    frontmatter = parseFrontmatter(text);
  } catch {
    frontmatter = {};
  }

  let symlink = false;
  let resolved = skillDir;
  try {
    symlink = (await lstat(skillDir)).isSymbolicLink();
    resolved = await realpath(skillDir);
  } catch {
    // Unresolvable (should not happen for a discovered skill) — fall back to
    // the walked path; consumers compare resolved paths within one scan, so a
    // consistent fallback never produces a false healthy/duplicate verdict.
  }

  const name = (typeof frontmatter.name === "string" && frontmatter.name) || basename(skillDir);
  const ext = attribution && attribution[name];
  return {
    name,
    file: skillFile,
    dir: skillDir,
    resolved,
    symlink,
    scanRoot: { kind: scanRoot.kind, ref: scanRoot.ref, root: scanRoot.root },
    version: frontmatter.version ?? null,
    updated: frontmatter.updated ?? null,
    provenance: frontmatter.provenance ?? null,
    category: frontmatter.category ?? null,
    description: frontmatter.description ?? null,
    // The Availability stamp (ADR-0014): "manual" | "off" from the stored
    // copy's frontmatter, null = Active. External occurrences get "off"
    // overlaid from the ZCode ledger after the scan (see buildInventory).
    availability: frontmatter.availability ?? null,
    tier: ext ? "external" : null,
    external: ext ? { source: ext.source, computedHash: ext.computedHash } : null,
    hash: bodyHash(text),
  };
}

// --- skills.sh lockfile attribution (ADR-0007/0008) -------------------------

// Read a skills-lock.json (skills.sh's record of the External skills it owns)
// into a name -> {source, sourceType, computedHash} map. Missing or malformed
// files contribute an empty map (attribution is best-effort, never fatal).
async function readLockfile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    const skills = parsed && typeof parsed === "object" ? parsed.skills : null;
    if (!skills || typeof skills !== "object") return {};
    const map = {};
    for (const [name, entry] of Object.entries(skills)) {
      if (!entry || typeof entry !== "object") continue;
      map[name] = {
        source: typeof entry.source === "string" ? entry.source : null,
        sourceType: typeof entry.sourceType === "string" ? entry.sourceType : null,
        computedHash: typeof entry.computedHash === "string" ? entry.computedHash : null,
      };
    }
    return map;
  } catch {
    return {};
  }
}

// --- orchestration -----------------------------------------------------------

/**
 * Load config and scan every configured scan root. Returns the inventory object
 * (without writing it). One entry per physical skill occurrence; broken
 * symlinks recorded distinctly. Never throws on a malformed SKILL.md.
 *
 * Attribution: the global skills.sh lockfile (`~/skills-lock.json`) covers every
 * agent root; a per-root lockfile (`<root>/skills-lock.json`) covers that root
 * (agent roots merge it over the global one with per-root precedence; vault /
 * project roots read it alone). Occurrences named in a lockfile are tagged
 * External. (ADR-0007/0008.)
 *
 * @param {string} [home] $HOME to resolve from.
 * @returns {Promise<object>} The inventory object (ADR-0003 schema).
 */
export async function buildInventory(home = homedir()) {
  const config = await loadConfig(home);

  // The global lockfile applies to every agent root; an agent root may also
  // carry its own lockfile (skills.sh writes skills-lock.json per install
  // scope), whose entries take precedence for that root.
  const globalLock = await readLockfile(join(home, "skills-lock.json"));

  const scanRoots = [];
  // The canonical store is a scan root of its own (schema v4, ADR-0014): an
  // Off skill is linked nowhere, so without scanning the store it would
  // vanish from every view and could never be switched back on. Scanned FIRST
  // so the canonical copy is the group's primary occurrence (its stamps are
  // the ones the views read).
  if (config.store) {
    scanRoots.push({ kind: "store", ref: "store", root: config.store, attribution: {} });
  }
  for (const key of config.agents) {
    const root = agentRoot(key, home);
    if (!root) continue;
    const rootLock = await readLockfile(join(root, "skills-lock.json"));
    scanRoots.push({ kind: "agent", ref: key, root, attribution: { ...globalLock, ...rootLock } });
  }
  for (const p of config.vaults) {
    scanRoots.push({ kind: "vault", ref: p, root: p, attribution: await readLockfile(join(p, "skills-lock.json")) });
  }
  for (const p of config.projects) {
    scanRoots.push({ kind: "project", ref: p, root: p, attribution: await readLockfile(join(p, "skills-lock.json")) });
  }

  const out = { skills: [], broken: [] };
  for (const r of scanRoots) {
    await scanRootTree(r, r.root, r.attribution, out);
  }

  // External Off is a ZCode-config disable, not a stamp (ADR-0007 — skills.sh
  // files are never written); the ledger recorded at disable time is overlaid
  // onto the occurrence so every view reads one uniform `availability` field.
  const ledger = config.zcodeDisables ?? {};
  for (const occ of out.skills) {
    if (occ.tier === "external" && ledger[occ.name]) occ.availability = "off";
  }

  return finalizeInventory(scanRoots, out);
}

function finalizeInventory(scanRoots, out) {
  const byScanRoot = {};
  for (const s of out.skills) {
    const key = `${s.scanRoot.kind}:${s.scanRoot.ref}`;
    byScanRoot[key] = (byScanRoot[key] ?? 0) + 1;
  }
  return {
    version: 4,
    generatedAt: new Date().toISOString(),
    counts: {
      skills: out.skills.length,
      broken: out.broken.length,
      scanRoots: scanRoots.length,
      byScanRoot,
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
