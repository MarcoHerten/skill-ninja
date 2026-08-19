// The Availability layer (ADR-0014) — Skill Ninja's lever on the context
// window. Three states per Skill (CONTEXT.md "Availability"):
//
//   Active  linked in the agent roots, loaded, auto-triggered (the default)
//   Manual  still listed and invocable by name, never auto-triggered
//   Off     loaded nowhere
//
// The mechanism is per tier (the hybrid):
//   Personal Off    unlink from every configured agent root + an
//                   `availability: "off"` stamp on the stored copy
//   Personal Manual links stay; the `description` moves into an
//                   `activation_text` stamp and is replaced by a placeholder,
//                   plus `disable-model-invocation: true` (Claude-Code family)
//   External Off    a ZCode-only config disable (`enable: false` by absolute
//                   SKILL.md path), tracked in the skill-ninja ledger so `on`
//                   removes only entries Skill Ninja wrote
//   External Manual not supported (would require writing skills.sh's files)
//
// All stamp writes are frontmatter-only edits in the `cat assign` style: the
// body, `version`, and the content hash never move (ADR-0005), there is no
// CHANGELOG entry — the store's git log (`availability …` commits) is the
// record. Commands are two-phase like doctor/ingest: dry run by default,
// `--apply` executes.

import { readFile, writeFile, rm, lstat, realpath, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { loadConfig, readRawConfig, writeRawConfig } from "./config.js";
import { agentRoot } from "./agents.js";
import { inventoryPath, parseFrontmatter } from "./inventory.js";
import { splitFrontmatter, quoteValue } from "./hash.js";
import { groupSkills, isPersonal, groupAvailability } from "./status.js";
import { groupCategory } from "./cat.js";
import { readCollections, resolveCollectionMembers } from "./collection.js";
import { linkSkill } from "./links.js";
import { tryCommit, tryPush } from "./git.js";

// The placeholder description written while Manual: honest about the state,
// deliberately free of trigger wording (the whole point — ADR-0010's
// "no description to match on → listed, invocable, silent" semantics).
export const MANUAL_PLACEHOLDER = "Manual skill — invoke explicitly by name.";

// --- frontmatter entry editing (block-aware) ----------------------------------
//
// `cat assign`'s line surgery works because its `category:` line is always a
// single line. The availability stamps must also REPLACE a `description`
// that may be a YAML block scalar (`description: >-` + indented lines) or sit
// inside a nested object, so this editor models the frontmatter as ordered
// entries — a `key:` header plus whichever continuation lines belong to it —
// and rebuilds the block. Everything it does not touch is preserved verbatim.

const BLOCK_HEADER = /^([>|])[0-9+-]*$/;

function parseFmEntries(fmLines) {
  const entries = [];
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      entries.push({ key: null, lines: [line] });
      i += 1;
      continue;
    }
    const val = m[2];
    const lines = [line];
    i += 1;
    // Continuation lines belong to this entry when the value opens a block
    // scalar (`>-` / `|`) or a nested object (empty value + indented child),
    // and keep belonging while lines are indented or blank.
    const opensBlock =
      BLOCK_HEADER.test(val.trim()) ||
      (val.trim() === "" && fmLines[i] !== undefined && /^\s+\S/.test(fmLines[i]));
    if (opensBlock) {
      while (i < fmLines.length && (fmLines[i].trim() === "" || /^\s+\S/.test(fmLines[i]))) {
        lines.push(fmLines[i]);
        i += 1;
      }
    }
    entries.push({ key: m[1], lines });
  }
  return entries;
}

function serializeFmEntries(entries) {
  return entries.map((e) => e.lines.join("\n")).join("\n");
}

// An entry's scalar value: a plain (possibly quoted) scalar from the header,
// or a block scalar folded to one line — the same normalization the inventory
// parser applies, so a value round-trips the way `add` would re-serialize it.
function entryValue(entry) {
  const m = entry.lines[0].match(/^[A-Za-z][\w-]*\s*:\s*(.*)$/);
  if (!m) return null;
  const val = m[1].trim();
  if (BLOCK_HEADER.test(val)) {
    const content = entry.lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l !== "");
    return content.length ? content.join(" ").replace(/\s+/g, " ") : null;
  }
  if (val === "" || val === "null" || val === "~") return null;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function setEntryLine(entries, key, line) {
  const idx = entries.findIndex((e) => e.key === key);
  if (idx !== -1) {
    entries[idx] = { key, lines: [line] };
    return entries;
  }
  const nameIdx = entries.findIndex((e) => e.key === "name");
  const at = nameIdx === -1 ? 0 : nameIdx + 1;
  entries.splice(at, 0, { key, lines: [line] });
  return entries;
}

function removeEntry(entries, key) {
  return entries.filter((e) => e.key !== key);
}

/**
 * Rewrite a stored SKILL.md's frontmatter for the target Availability state
 * (frontmatter-only; the body is preserved byte-for-byte). Transitions out of
 * Manual first restore the description from `activation_text`, so an Off or
 * Active skill always carries its real description.
 *
 * @param {string} text The stored SKILL.md content.
 * @param {"active"|"manual"|"off"} target
 * @returns {string} The rewritten content.
 */
export function applyAvailabilityStamps(text, target) {
  const split = splitFrontmatter(text);
  let entries = split ? parseFmEntries(split.fm) : [];
  const has = (k) => entries.some((e) => e.key === k);
  const value = (k) => {
    const e = entries.find((x) => x.key === k);
    return e ? entryValue(e) : null;
  };
  const set = (k, v) => {
    entries = setEntryLine(entries, k, `${k}: ${typeof v === "string" ? quoteValue(v) : v}`);
  };
  const remove = (k) => {
    entries = removeEntry(entries, k);
  };

  // Normalize out of Manual: restore the preserved activation text.
  if (has("activation_text")) {
    const preserved = value("activation_text");
    if (preserved) set("description", preserved);
    remove("activation_text");
    remove("disable-model-invocation");
  }

  if (target === "active") {
    remove("availability");
  } else if (target === "off") {
    set("availability", "off");
  } else if (target === "manual") {
    const current = value("description");
    if (current && current !== MANUAL_PLACEHOLDER) set("activation_text", current);
    set("description", MANUAL_PLACEHOLDER);
    set("disable-model-invocation", true);
    set("availability", "manual");
  }

  const fm = serializeFmEntries(entries);
  if (!split) return `---\n${fm}\n---\n${text}`;
  // split.body already carries its own leading newline when the original had
  // a blank line after the fence (the first body element is ""); joining
  // reproduces the body byte-for-byte either way.
  const body = split.body.join("\n");
  return `---\n${fm}\n---\n${body}`;
}

// --- link operations -----------------------------------------------------------

function underStore(dir, store) {
  if (!store) return false;
  const prefix = store.endsWith("/") ? store : store + "/";
  return dir === store || dir.startsWith(prefix);
}

function agentLinkPaths(config, home, name) {
  return config.agents
    .map((key) => agentRoot(key, home))
    .filter(Boolean)
    .map((root) => join(root, name));
}

/**
 * Remove a skill's links from every configured agent root — only links that
 * resolve into the canonical store. A real directory at a link path is never
 * deleted (that is content, and consolidating it is `doctor`'s job).
 */
async function unlinkEverywhere(config, home, store, name) {
  // Compare against the CANONICAL store path: the config may name it through
  // a symlink (e.g. /tmp vs /private/tmp on macOS) while realpath resolves
  // through it — a prefix check against the raw config path would misjudge
  // our own links as foreign.
  const storeReal = await realpath(store).catch(() => store);
  const result = { removed: [], skipped: [] };
  for (const p of agentLinkPaths(config, home, name)) {
    let st;
    try {
      st = await lstat(p);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    if (!st.isSymbolicLink()) {
      result.skipped.push(p);
      continue;
    }
    let resolved;
    try {
      resolved = await realpath(p);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        result.skipped.push(p);
        continue;
      }
      throw err;
    }
    if (!underStore(resolved, storeReal)) {
      result.skipped.push(p);
      continue;
    }
    await rm(p, { recursive: true, force: true });
    result.removed.push(p);
  }
  return result;
}

/**
 * (Re-)link a skill into every configured agent root. A real directory at a
 * link path is skipped with a warning — `linkSkill` would replace it, and
 * replacing content that was never consolidated is data loss, not linking.
 */
async function relinkEverywhere(config, home, store, name) {
  const result = { linked: [], skipped: [] };
  const target = join(store, name);
  for (const p of agentLinkPaths(config, home, name)) {
    try {
      const st = await lstat(p);
      if (!st.isSymbolicLink()) {
        result.skipped.push(p);
        continue;
      }
    } catch (err) {
      if (!(err && err.code === "ENOENT")) throw err;
    }
    await linkSkill(p, target);
    result.linked.push(p);
  }
  return result;
}

// --- ZCode config projection (External Off) ------------------------------------

export function zcodeUserConfigPath(home = homedir()) {
  return join(home, ".zcode", "cli", "config.json");
}

// Read the ZCode user config strictly: a malformed file must throw (never be
// rewritten around a parse error), a missing one starts empty.
async function readZcodeConfig(home) {
  const file = zcodeUserConfigPath(home);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw);
}

async function writeZcodeConfig(home, cfg) {
  const file = zcodeUserConfigPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Disable (or re-enable) skill paths in ZCode's user config. Surgical: only
 * the given `skills` entries are touched — every other key, including the
 * user's own hand-set overrides, is preserved byte-for-byte around them.
 */
export async function zcodeSetDisabled(home, paths, disabled) {
  const cfg = await readZcodeConfig(home);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`${zcodeUserConfigPath(home)} is not a JSON object`);
  }
  if (!cfg.skills || typeof cfg.skills !== "object") cfg.skills = {};
  for (const p of paths) {
    if (disabled) {
      cfg.skills[p] = { ...(cfg.skills[p] ?? {}), enable: false };
    } else {
      delete cfg.skills[p]; // remove the override entirely — cleaner than enable: true
    }
  }
  await writeZcodeConfig(home, cfg);
}

// The ZCode-discovered agent roots (discovery levels 2 and 3): a disable is
// keyed by absolute SKILL.md path, so every root the skill occurs at needs
// its own entry.
const ZCODE_DISCOVERED_AGENTS = new Set(["zcode", "agents"]);

function zcodePathsFor(group) {
  return group.occurrences
    .filter((o) => o.scanRoot?.kind === "agent" && ZCODE_DISCOVERED_AGENTS.has(o.scanRoot.ref))
    .map((o) => o.file);
}

// --- the on / off / manual command ---------------------------------------------

function parseSwitchArgs(args) {
  const opts = { names: [], category: null, tier: null, collection: null, except: [], apply: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--category") {
      opts.category = args[++i];
      if (!opts.category) return { error: "--category needs a value" };
    } else if (a === "--tier") {
      opts.tier = args[++i];
      if (opts.tier !== "personal") {
        return { error: `--tier must be personal (got '${opts.tier ?? ""}')` };
      }
    } else if (a === "--collection") {
      opts.collection = args[++i];
      if (!opts.collection) return { error: "--collection needs a value" };
    } else if (a === "--except") {
      const v = args[++i];
      if (!v) return { error: "--except needs a comma-separated name list" };
      opts.except.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (a.startsWith("--")) {
      return { error: `unknown option: ${a}` };
    } else {
      opts.names.push(a);
    }
  }
  return opts;
}

// Resolve the uniform selector set (names, --category, --tier, --collection,
// --except) against the cached inventory. Explicit names restrict to
// themselves (AND with the flags); unknown explicit names are reported as
// missing. An unknown --collection is a usage error (selectors are strict —
// unlike the `cat @<name>` view, a bulk switch must never silently no-op).
// The store-side collections map is pre-read by the caller (ADR-0017).
function resolveSelection(opts, inventory, config, collections) {
  let groups = groupSkills(inventory.skills ?? []);
  if (opts.category) {
    const cat = opts.category.toLowerCase();
    groups = groups.filter(
      (g) => (groupCategory(g) ?? "").toLowerCase() === cat,
    );
  }
  if (opts.tier === "personal") {
    groups = groups.filter((g) => g.occurrences.some((o) => isPersonal(o, config.store)));
  }
  if (opts.collection) {
    const patterns = collections[opts.collection];
    if (!Array.isArray(patterns)) {
      const present = Object.keys(collections);
      return {
        selected: [],
        missing: [],
        error:
          `No collection '${opts.collection}'.` +
          (present.length
            ? ` Collections present: ${present.join(", ")}.`
            : " (none saved — try `ninja collection save`)."),
      };
    }
    const memberNames = new Set(resolveCollectionMembers(patterns, inventory).map((g) => g.name));
    groups = groups.filter((g) => memberNames.has(g.name));
  }
  const missing = opts.names.filter((n) => !groups.some((g) => g.name === n));
  let selected = opts.names.length ? groups.filter((g) => opts.names.includes(g.name)) : groups;
  if (opts.except.length) selected = selected.filter((g) => !opts.except.includes(g.name));
  return { selected, missing };
}

// Which mechanism a skill is switched through: External attribution wins over
// store presence (a skills.sh-owned name is never stamped even if a stale
// store copy exists — doctor's ownership rule).
function classifyGroup(group, config) {
  if (group.occurrences.some((o) => o.tier === "external")) return "external";
  if (config.store && existsSync(join(config.store, group.name, "SKILL.md"))) return "personal";
  return "unknown";
}

/**
 * Run `ninja on | off | manual` — the Availability switch (ADR-0014). Dry run
 * by default; `--apply` executes. Returns the process exit code.
 *
 * @param {"on"|"off"|"manual"} command
 * @param {string[]} args
 */
export async function availabilityCommand(command, args) {
  const out = process.stdout;
  const err = process.stderr;
  const target = command === "on" ? "active" : command;

  const usage =
    "Try: ninja on|off|manual <names…> [--category <c>] [--tier personal] [--collection <name>] [--except a,b] [--apply]";
  const opts = parseSwitchArgs(args);
  if (opts.error) {
    err.write(`${opts.error}\n${usage}\n`);
    return 2;
  }

  const home = homedir();
  let raw;
  try {
    raw = await readFile(inventoryPath(home), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      out.write(
        `No Skill Ninja inventory found at ${inventoryPath(home)}.\n` +
          "Run `ninja init` to scan your skills, then re-run.\n",
      );
      return 0;
    }
    throw e;
  }
  const inventory = JSON.parse(raw);

  let config;
  try {
    config = await loadConfig(home);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      err.write("No Skill Ninja configuration found. Run `ninja init` first.\n");
      return 2;
    }
    throw e;
  }
  if (!config.store) {
    err.write("No canonical store configured (set `store` in ~/.skill-ninja/config.json).\n");
    return 2;
  }

  const { selected, missing, error: selectionError } = resolveSelection(
    opts,
    inventory,
    config,
    await readCollections(config),
  );
  if (selectionError) {
    err.write(`${selectionError}\n`);
    return 2;
  }
  if (missing.length) {
    err.write(
      `No skill named ${missing.map((n) => `'${n}'`).join(", ")} in the inventory.\n` +
        "Run `ninja init` to refresh, or check the name (try `ninja find <term>`).\n",
    );
    return 2;
  }
  if (selected.length === 0) {
    err.write("No skills match the given selectors.\n");
    return 2;
  }

  // The self-preservation guard: switching Skill Ninja itself off or manual
  // could remove the very tool that restores it.
  if (selected.some((g) => g.name === "ninja")) {
    err.write("Refusing to switch the 'ninja' skill itself — Skill Ninja must stay available.\n");
    return 2;
  }

  const kinds = new Map(selected.map((g) => [g.name, classifyGroup(g, config)]));
  const unmanageable = [...kinds].filter(([, k]) => k === "unknown").map(([n]) => n);
  if (unmanageable.length) {
    err.write(
      `No stored copy and no skills.sh attribution for ${unmanageable.map((n) => `'${n}'`).join(", ")}.\n` +
        "Availability is stamped on the stored copy — run `ninja add` (or `ninja doctor`) first.\n",
    );
    return 2;
  }
  if (target === "manual") {
    const externals = [...kinds].filter(([, k]) => k === "external").map(([n]) => n);
    if (externals.length) {
      err.write(
        `Manual needs a stored copy to stamp, and skills.sh owns: ${externals.join(", ")} (ADR-0007).\n` +
          "External skills can be switched off (ZCode only) or left active.\n",
      );
      return 2;
    }
  }

  // The plan: what would happen per skill. Personal entries describe the
  // stamp + link work; External entries the ZCode-config projection.
  const plan = selected.map((g) => {
    const kind = kinds.get(g.name);
    const current = groupAvailability(g);
    if (kind === "external") {
      const paths = zcodePathsFor(g);
      const action =
        target === "off"
          ? paths.length
            ? `disable in ZCode config (${paths.length} path${paths.length === 1 ? "" : "s"})`
            : "nothing to disable — not present in any ZCode-discovered root"
          : paths.length || config.zcodeDisables[g.name]
            ? "remove the ZCode config disable"
            : "already active — no ZCode override present";
      return { name: g.name, kind, current, paths, action };
    }
    let action;
    if (target === "off") action = "unlink from agent roots + stamp availability: off";
    else if (target === "manual") action = "stamp availability: manual (description preserved as activation_text)";
    else action = "stamp active (restore description if manual) + link into agent roots";
    return { name: g.name, kind, current, action };
  });

  const verb = target === "active" ? "on" : target;
  out.write(`Skill Ninja ${verb} — dry run (${plan.length} skill${plan.length === 1 ? "" : "s"} selected)\n`);
  if (inventory.generatedAt) out.write(`(inventory from ${inventory.generatedAt})\n`);
  out.write("\n");
  for (const p of plan) {
    out.write(`  ${p.name} [${p.current} → ${target}]: ${p.action}\n`);
  }
  if (!opts.apply) {
    out.write(
      "\nNothing was changed. Re-run with --apply to execute.\n" +
        "Availability takes effect in NEW agent sessions (skills load at session start).\n",
    );
    return 0;
  }

  // --- apply ------------------------------------------------------------------
  const stampedNames = [];
  const skippedPaths = [];
  const alreadyDone = [];

  for (const p of plan) {
    if (p.kind === "personal") {
      const storedFile = join(config.store, p.name, "SKILL.md");
      const text = await readFile(storedFile, "utf8");
      const next = applyAvailabilityStamps(text, target);
      if (next !== text) {
        await writeFile(storedFile, next, "utf8");
        stampedNames.push(p.name);
      }
      if (target === "off") {
        const r = await unlinkEverywhere(config, home, config.store, p.name);
        skippedPaths.push(...r.skipped);
      } else if (target === "active") {
        const r = await relinkEverywhere(config, home, config.store, p.name);
        skippedPaths.push(...r.skipped);
      }
    } else {
      // External: the ZCode projection + the ledger. `on` with neither live
      // paths nor a ledger entry is a no-op (already active).
      if (target === "off") {
        if (p.paths.length === 0) {
          alreadyDone.push(`${p.name} — not present in any ZCode-discovered root; nothing disabled`);
          continue;
        }
        await zcodeSetDisabled(home, p.paths, true);
        await updateLedger(home, p.name, p.paths);
      } else if (p.paths.length || config.zcodeDisables[p.name]) {
        const paths = config.zcodeDisables[p.name] ?? p.paths;
        await zcodeSetDisabled(home, paths, false);
        await updateLedger(home, p.name, null);
      } else {
        alreadyDone.push(`${p.name} — already active (no ZCode override present)`);
      }
    }
  }

  // One commit for the whole batch (the ingest precedent; `cat assign`'s
  // per-skill commits fit one curated edit, not a bulk switch).
  let committed = false;
  let pushed = false;
  if (stampedNames.length > 0) {
    committed = tryCommit(
      config.store,
      stampedNames,
      `availability ${target} (${stampedNames.length} skill${stampedNames.length === 1 ? "" : "s"})`,
    );
    pushed = committed ? tryPush(config.store) : false;
  }

  out.write(`\nSkill Ninja ${verb} — applied\n`);
  out.write(
    `${plan.length} skill${plan.length === 1 ? "" : "s"} processed` +
      `${stampedNames.length ? `, ${stampedNames.length} stamped` : ""}.\n`,
  );
  for (const d of alreadyDone) out.write(`  - ${d}\n`);
  for (const p of skippedPaths) {
    out.write(`  - skipped ${p} (not a store link — a real directory is never replaced)\n`);
  }
  if (committed) out.write(`Committed to ${config.store}.\n`);
  if (pushed) out.write("Pushed to the private remote.\n");
  out.write(
    "Run `ninja init` to refresh the inventory.\n" +
      "Availability takes effect in NEW agent sessions (skills load at session start).\n",
  );
  return 0;
}

// The External-off ledger (skill-ninja config `zcode_disables`): records the
// exact config entries Skill Ninja wrote so `on` removes only its own.
// `paths === null` removes the entry.
async function updateLedger(home, name, paths) {
  const raw = (await readRawConfig(home)) ?? {};
  if (!raw.zcode_disables || typeof raw.zcode_disables !== "object") raw.zcode_disables = {};
  if (paths === null) delete raw.zcode_disables[name];
  else raw.zcode_disables[name] = paths;
  await writeRawConfig(home, raw);
}
