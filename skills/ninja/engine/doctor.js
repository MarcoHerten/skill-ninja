// `ninja doctor` — detect problems across the **Skill** landscape, propose
// a repair for each, and apply repairs only with the user's approval (Issue #6).
//
// Approval model (ADR-0006): `doctor` with no flag is a DETECT + REPORT dry run
// that changes NOTHING; `doctor --apply` is the explicit approval that applies
// every proposed repair and prints a summary of applied changes. `--only
// broken|duplicates|orphans` scopes which problem types are considered.
//
// Detection reads the **cached inventory** (ADR-0003) written by `init` — it does
// NOT re-scan. To tell a *problematic* duplicate (a loose-copy spread) from a
// healthy tool-asymmetry spread (all symlinks into the store), doctor classifies
// each occurrence against the filesystem with read-only `lstat` (the dry run
// never mutates).
//
// Repairs reuse `add`'s linking pattern (`engine/links.js#linkSkill`): one
// canonical copy in the **canonical store**, linked everywhere — resolving
// **tool asymmetry** (CONTEXT.md). (SPEC.md: "no multi-target deploy".)
//
// Healthy-spread rule: a name spread is a duplicate problem only when its
// occurrences resolve to ≥2 independent content locations (`realpath`). One
// canonical copy plus links into it — `add`'s store links OR skills.sh's
// install pattern (a real dir in one agent root, the other roots symlinked
// into it) — is the healthy state and is never reported. skills.sh-owned
// (External, lockfile-attributed) and plugin-bundled (Plugin) skills are
// audited but never re-linked (ADR-0007/0018): doctor proposes no repair for
// them at all.

import { readFile, readdir, mkdir, copyFile, unlink, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { scanRootLabel } from "./status.js";
import { linkSkill } from "./links.js";

// --- argument parsing --------------------------------------------------------

function parseDoctorArgs(args) {
  const opts = { apply: false, only: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--only") {
      const v = args[++i];
      if (!["broken", "duplicates", "orphans"].includes(v)) {
        return { error: `--only must be broken, duplicates, or orphans (got '${v ?? ""}')` };
      }
      opts.only = v;
    } else {
      return { error: `unknown option: ${a}` };
    }
  }
  return opts;
}

// --- occurrence classification (read-only) -----------------------------------

// Is `dir` the canonical store itself or a descendant of it? (ADR-0004 uses the
// same check for the Personal-tier heuristic.)
function underStore(dir, store) {
  if (!store) return false;
  const prefix = store.endsWith("/") ? store : store + "/";
  return dir === store || dir.startsWith(prefix);
}

/**
 * Classify an inventory occurrence against the filesystem + store.
 * @returns {"store"|"link"|"loose"} — see ADR-0006.
 */
async function classifyOcc(occ, store) {
  if (underStore(occ.dir, store)) return "store";
  try {
    const st = await lstat(occ.dir);
    return st.isSymbolicLink() ? "link" : "loose";
  } catch (err) {
    // Gone since init — nothing live to repair; treat as loose so it is not
    // silently hidden, but it has no content to consolidate.
    if (err && err.code === "ENOENT") return "loose";
    throw err;
  }
}

// The occurrence's resolved (realpath) content location — for a symlink, the
// directory it points at; for a real dir, itself. Comparing resolved paths
// across a name group is how doctor counts independent content copies (a
// canonical spread and its links all resolve to the same place). A dir gone
// since init resolves to itself (nothing live to point elsewhere).
async function resolveDir(dir) {
  try {
    return await realpath(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return dir;
    throw err;
  }
}

// --- detection ---------------------------------------------------------------

/**
 * Detect problems from the cached inventory. Returns
 * `{ broken:[...], duplicates:[...], orphans:[] }`. Each finding carries the
 * data needed both to report and to apply a repair (ADR-0006).
 *
 * @param {object} inventory The cached inventory (ADR-0003 schema).
 * @param {{store?:string|null}} config Resolved config (only `store` is used).
 */
export async function detect(inventory, config) {
  const store = config?.store ?? null;
  const skills = inventory.skills ?? [];
  const findings = { broken: [], duplicates: [], orphans: [] };

  // Broken links — straight from the inventory; no store needed.
  for (const b of inventory.broken ?? []) {
    findings.broken.push({ type: "broken", path: b.path, scanRoot: b.scanRoot });
  }

  // Dedup / orphan features are store-relative (ADR-0006).
  if (!store) return findings;

  // Classify every occurrence once (read-only).
  const classified = [];
  for (const occ of skills) {
    classified.push({ occ, kind: await classifyOcc(occ, store), resolved: await resolveDir(occ.dir) });
  }

  // Group by name, preserving first-seen order.
  const order = [];
  const byName = new Map();
  for (const c of classified) {
    if (!byName.has(c.occ.name)) {
      byName.set(c.occ.name, []);
      order.push(c.occ.name);
    }
    byName.get(c.occ.name).push(c);
  }

  for (const name of order) {
    const group = byName.get(name);

    // skills.sh-owned (External, lockfile-attributed) and plugin-bundled
    // (Plugin) skills are audited, never re-linked (ADR-0007/0018): no
    // consolidation or orphan repair is proposed for them — managing those
    // installs is `npx skills`'s / the agent's plugin manager's job.
    if (group.some((c) => c.occ.tier === "external" || c.occ.tier === "plugin")) continue;

    const loose = group.filter((c) => c.kind === "loose");

    if (group.length > 1) {
      // A spread. Healthy when every occurrence resolves to ONE content
      // location — all links into the store (`add`/dedup) or one real canonical
      // dir with the other locations linked into it (skills.sh's pattern). A
      // duplicate problem needs ≥2 independent content copies.
      const sources = new Set(group.map((c) => c.resolved));
      if (sources.size <= 1) continue;
      // Nothing repairable: no store copy and no loose copy to consolidate from
      // (e.g. links diverging to targets outside every scan root).
      const hasStoreOcc = group.some((c) => c.kind === "store");
      if (!hasStoreOcc && loose.length === 0) continue;
      findings.duplicates.push(buildConsolidation(name, group, store));
    } else if (group.length === 1 && group[0].kind === "loose") {
      // A solo loose copy — an orphan the user never canonically ingested.
      findings.orphans.push(buildConsolidation(name, group, store));
    }
  }

  return findings;
}

// Build a consolidation finding (used for both duplicates and orphans): the
// canonical content source + the loose dirs to turn into links. Canonical source
// = an occurrence under the store if any; else the first loose by sorted path.
function buildConsolidation(name, group, store) {
  const storeSkillDir = join(store, name);
  const storeOcc = group.find((c) => c.kind === "store");
  const looseDirs = group
    .filter((c) => c.kind === "loose")
    .map((c) => c.occ.dir)
    .sort((a, b) => a.localeCompare(b));

  let sourceDir;
  let sourceFromStore = false;
  if (storeOcc) {
    sourceDir = storeSkillDir;
    sourceFromStore = true;
  } else {
    // First loose by sorted path is the canonical content winner.
    sourceDir = looseDirs[0];
  }

  return {
    name,
    storeSkillDir,
    sourceDir,
    sourceFromStore,
    occurrences: group.map((c) => c.occ),
    linkDirs: looseDirs,
  };
}

// --- apply -------------------------------------------------------------------

// Copy a Skill dir verbatim (SKILL.md + bundled assets) into dest. Skips symlinks
// so a weird source can't pull in unrelated trees. (doctor copies verbatim; it
// does NOT re-stamp — that is `add`'s job, ADR-0005.)
async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    return; // nothing to copy (defensive; should not happen for a discovered skill)
  }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (e.isFile()) await copyFile(s, d);
    // symlinks are intentionally skipped.
  }
}

// Consolidate one Skill into the canonical store + link its loose locations.
// Reuses add's linking pattern: ensure <store>/<name> holds the content, then
// symlink each loose dir -> <store>/<name>. Never removes the store copy itself.
async function consolidate(store, finding) {
  const { storeSkillDir, sourceDir, linkDirs } = finding;
  if (!existsSync(join(storeSkillDir, "SKILL.md"))) {
    await copyTree(sourceDir, storeSkillDir);
  }
  for (const dir of linkDirs) {
    if (dir === storeSkillDir) continue; // never replace the canonical copy
    await linkSkill(dir, storeSkillDir);
  }
}

/**
 * Apply the given (already `--only`-scoped) findings. Returns a summary of what
 * changed: `{ broken:number, duplicates:[{name,target,linked}], orphans:[...] }`.
 */
export async function applyRepairs(findings, config) {
  const store = config.store;
  const summary = { broken: 0, duplicates: [], orphans: [] };

  for (const f of findings.broken) {
    await unlink(f.path).catch(() => {}); // remove the dangling symlink
    summary.broken += 1;
  }

  for (const f of findings.duplicates) {
    await consolidate(store, f);
    summary.duplicates.push({ name: f.name, target: f.storeSkillDir, linked: f.linkDirs.length });
  }

  for (const f of findings.orphans) {
    await consolidate(store, f);
    summary.orphans.push({ name: f.name, target: f.storeSkillDir, linked: f.linkDirs.length });
  }

  return summary;
}

// Keep only the findings for the requested problem type (or all when `only` is null).
function scopeFindings(findings, only) {
  if (!only) return findings;
  const empty = { broken: [], duplicates: [], orphans: [] };
  return { ...empty, [only]: findings[only] };
}

// --- rendering ---------------------------------------------------------------

function plural(n, word) {
  if (n === 1) return `1 ${word}`;
  // consonant + y -> -ies (copy -> copies); everything else gets a plain -s.
  if (/[^aeiou]y$/i.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  return `${n} ${word}s`;
}

function listFindings(findings, verb) {
  // verb = "Proposed repair" (dry run) or "Applied" (--apply).
  const lines = [];

  if (findings.broken.length) {
    lines.push("", `${plural(findings.broken.length, "Broken symlink")}:`);
    for (const f of findings.broken) {
      lines.push(`  - ${f.path} (${scanRootLabel(f.scanRoot)}).`);
      lines.push(`    ${verb}: remove the broken symlink.`);
    }
  }

  if (findings.duplicates.length) {
    lines.push("", `${plural(findings.duplicates.length, "Duplicate")}:`);
    for (const f of findings.duplicates) {
      lines.push(
        `  - '${f.name}' is spread across ${plural(f.occurrences.length, "location")}, ` +
          `including ${plural(f.linkDirs.length, "loose copy")} (the same skill in several places):`,
      );
      for (const occ of f.occurrences) {
        lines.push(`      ${scanRootLabel(occ.scanRoot)} - ${occ.dir}`);
      }
      const from = f.sourceFromStore
        ? `the canonical store copy at ${f.storeSkillDir}`
        : `${f.sourceDir}`;
      lines.push(
        `    ${verb}: consolidate into ${f.storeSkillDir} (content from ${from}) ` +
          `and link the ${plural(f.linkDirs.length, "loose copy")} to it.`,
      );
    }
  }

  if (findings.orphans.length) {
    lines.push("", `${plural(findings.orphans.length, "Orphan")}:`);
    for (const f of findings.orphans) {
      const occ = f.occurrences[0];
      lines.push(
        `  - '${f.name}' is a loose copy at ${occ.dir} (${scanRootLabel(occ.scanRoot)}), ` +
          `not linked to the canonical store.`,
      );
      lines.push(
        `    ${verb}: ingest into ${f.storeSkillDir} and link its current location to it.`,
      );
    }
  }

  return lines;
}

/**
 * Render the doctor report.
 * @param {object} findings The (scoped) findings.
 * @param {object} opts
 * @param {boolean} opts.apply Dry-run vs applied framing.
 * @param {string|null} [opts.generatedAt] Inventory timestamp for the header.
 * @param {object} [opts.summary] Applied-changes summary (apply mode only).
 */
export function renderDoctor(findings, opts) {
  const { apply, generatedAt, summary } = opts;
  const total = findings.broken.length + findings.duplicates.length + findings.orphans.length;

  const lines = [
    apply ? "Skill Ninja doctor — applying repairs" : "Skill Ninja doctor — detect & report (dry run)",
  ];
  if (generatedAt) lines.push(`(inventory from ${generatedAt})`);

  if (total === 0) {
    lines.push("", "No problems detected. Your skill landscape is healthy.");
    if (!apply) {
      lines.push("", "Nothing to do. (Re-run after `init` whenever the landscape changes.)");
    }
    return lines.join("\n") + "\n";
  }

  lines.push(...listFindings(findings, apply ? "Applied" : "Proposed repair"));

  if (!apply) {
    lines.push(
      "",
      "Nothing was changed. Run `ninja doctor --apply` to apply all proposed repairs.",
    );
    return lines.join("\n") + "\n";
  }

  // Applied summary (SPEC.md user story #21).
  lines.push("", "Summary of applied changes:");
  lines.push(`  - ${plural(summary.broken, "broken symlink")} removed.`);
  if (summary.duplicates.length) {
    for (const d of summary.duplicates) {
      lines.push(`  - '${d.name}' consolidated into ${d.target} (${plural(d.linked, "location")} linked).`);
    }
  } else {
    lines.push("  - No duplicates consolidated.");
  }
  if (summary.orphans.length) {
    for (const o of summary.orphans) {
      lines.push(`  - '${o.name}' ingested into ${o.target} (${plural(o.linked, "location")} linked).`);
    }
  } else {
    lines.push("  - No orphans ingested.");
  }
  lines.push("", "Run `ninja init` to refresh the inventory, then `doctor` to re-check.");
  return lines.join("\n") + "\n";
}

// --- command -----------------------------------------------------------------

/**
 * Run `ninja doctor`. Returns the process exit code.
 * @param {string[]} args
 */
export async function doctorCommand(args) {
  const out = process.stdout;
  const err = process.stderr;
  const home = homedir();

  const opts = parseDoctorArgs(args);
  if (opts.error) {
    err.write(`${opts.error}\n`);
    err.write("Try: ninja doctor [--apply] [--only broken|duplicates|orphans]\n");
    return 2;
  }

  // Read the cached inventory. If absent, tell the user to run init (exit 0).
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      out.write(
        `No Skill Ninja inventory found at ${inventoryPath(home)}.\n` +
          "Run `ninja init` to scan your skills, then re-run `doctor`.\n",
      );
      return 0;
    }
    throw e;
  }
  const inventory = JSON.parse(raw);

  // Config feeds the canonical store path (dedup/orphan features are store-relative).
  let config;
  try {
    config = await loadConfig(home);
  } catch (e) {
    if (e && e.code === "ENOENT") config = { store: null };
    else throw e;
  }

  const all = await detect(inventory, config);
  const findings = scopeFindings(all, opts.only);

  // `detect` populates only broken-link findings when `store` is unset (dedup/
  // orphan features are store-relative — ADR-0006), so apply is always safe here.
  if (opts.apply) {
    const summary = await applyRepairs(findings, config);
    out.write(renderDoctor(findings, { apply: true, generatedAt: inventory.generatedAt, summary }));
  } else {
    out.write(renderDoctor(findings, { apply: false, generatedAt: inventory.generatedAt }));
  }
  return 0;
}
