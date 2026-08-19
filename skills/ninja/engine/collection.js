// `ninja collection` — named, personal filters over the cached inventory
// (ADR-0015). A Collection is a name plus a list of patterns (exact skill
// names or `prefix*` globs) stored in ~/.skill-ninja/config.json — LOCAL,
// PERSONAL state that never touches the product repo or the shared store
// (the deliberate counter-point to ADR-0013's categories-as-stamps: a
// collection is the owner's view, not data about the skill).
//
// The views resolve patterns live: `cat @<name>` (bundle under its content
// categories), `find @<name>`, the page's collection filter, and the
// availability selectors (`--collection <name>`). This module owns the one
// matching rule they all share.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readRawConfig, writeRawConfig } from "./config.js";
import { groupSkills } from "./status.js";

/**
 * Does one pattern match a skill name? Exact (case-insensitive) or a
 * trailing-`*` prefix glob (`aphrodite*` matches `aphrodite` and
 * `aphrodite-linkedin-post`). The only glob the rule supports — the names it
 * filters are slugs, and one documented shape beats a regex surface.
 */
export function patternMatchesName(pattern, name) {
  const p = String(pattern).toLowerCase();
  const n = String(name).toLowerCase();
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/**
 * The inventory's name-groups a collection's patterns resolve to (live —
 * re-resolved by every view, so a stored skill added later simply appears).
 */
export function resolveCollectionMembers(patterns, inventory) {
  const groups = groupSkills(inventory?.skills ?? []);
  return groups.filter((g) => patterns.some((p) => patternMatchesName(p, g.name)));
}

/**
 * The names of every collection a skill belongs to (for the page's
 * data-collections attribute — membership computed server-side, the cockpit
 * only string-compares).
 */
export function collectionsForName(name, collections) {
  const out = [];
  for (const [cname, patterns] of Object.entries(collections ?? {})) {
    if (patterns.some((p) => patternMatchesName(p, name))) out.push(cname);
  }
  return out;
}

// The resolved config's `collections` object (already normalized by
// config.js's shared name-list rule); {} when none are configured.
export function configuredCollections(config) {
  return config?.collections && typeof config.collections === "object" ? config.collections : {};
}

async function loadCollections(home) {
  const raw = await readRawConfig(home);
  const collections = raw?.collections && typeof raw.collections === "object" ? raw.collections : {};
  return { raw, collections };
}

// --- the command ---------------------------------------------------------------

function listCommand(out, collections, name, inventory) {
  const lines = ["Skill Ninja collections"];
  if (name) {
    const patterns = collections[name];
    if (!Array.isArray(patterns)) {
      out.write(`No collection '${name}'.\n`);
      const present = Object.keys(collections);
      if (present.length) out.write(`Collections present: ${present.join(", ")}.\n`);
      return 2;
    }
    const matching = resolveCollectionMembers(patterns, inventory)
      .map((g) => g.name)
      .sort((a, b) => a.localeCompare(b));
    lines.push("", `'${name}' (${patterns.length} pattern${patterns.length === 1 ? "" : "s"}, ${matching.length} matching skill${matching.length === 1 ? "" : "s"}):`);
    for (const p of patterns) lines.push(`  ${p}`);
    if (inventory) {
      lines.push("", "Matching skills:");
      if (matching.length === 0) lines.push("  (none in the current inventory)");
      else for (const m of matching) lines.push(`  ${m}`);
    }
    out.write(lines.join("\n") + "\n");
    return 0;
  }
  const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));
  lines.push("");
  if (names.length === 0) {
    lines.push("(no collections saved)");
    lines.push("", "Save one with: ninja collection save <name> <skill|prefix*> […]");
  } else {
    for (const n of names) {
      const patterns = collections[n];
      const count = inventory
        ? resolveCollectionMembers(patterns, inventory).length
        : null;
      const resolved = count === null ? "" : `, ${count} matching`;
      lines.push(`  ${n} (${patterns.length} pattern${patterns.length === 1 ? "" : "s"}${resolved})`);
    }
    lines.push("", "Filter with: cat @<name> | find @<name> | off/manual/on --collection <name>");
  }
  out.write(lines.join("\n") + "\n");
  return 0;
}

async function saveCommand(out, err, home, args, inventory) {
  const [name, ...patterns] = args;
  if (!name || patterns.length === 0) {
    err.write("save needs a collection name and at least one skill name or prefix glob.\n");
    err.write("Try: ninja collection save <name> <skill|prefix*> [<skill|prefix*> …]\n");
    return 2;
  }
  if (name.includes("/") || name.includes("@") || name.trim() === "") {
    err.write(`Invalid collection name: '${name}' (no "/", no "@").\n`);
    return 2;
  }

  // Loose by design (ADR-0015): an unmatched pattern warns — a collection may
  // legitimately reference names not yet in the inventory — but never errors.
  if (inventory) {
    const allNames = groupSkills(inventory.skills ?? []);
    const unmatched = patterns.filter((p) => !allNames.some((g) => patternMatchesName(p, g.name)));
    if (unmatched.length) {
      out.write(
        `Warning: ${unmatched.map((p) => `'${p}'`).join(", ")} match no skill in the current inventory. ` +
          "Stored anyway (collections may reference names that appear later).\n",
      );
    }
  }

  const { raw, collections } = await loadCollections(home);
  const members = [...new Set(patterns)];
  const existed = Array.isArray(collections[name]);
  collections[name] = members;
  raw.collections = collections;
  await writeRawConfig(home, raw);
  out.write(
    `${existed ? "Updated" : "Saved"} collection '${name}' with ${members.length} pattern${members.length === 1 ? "" : "s"}. ` +
      `Filter with: cat @${name}\n`,
  );
  return 0;
}

async function forgetCommand(out, err, home, args) {
  const [name] = args;
  if (!name) {
    err.write("forget needs a collection name.\n");
    err.write("Try: ninja collection forget <name>\n");
    return 2;
  }
  const { raw, collections } = await loadCollections(home);
  if (!Array.isArray(collections[name])) {
    err.write(`No collection '${name}'.\n`);
    return 2;
  }
  delete collections[name];
  raw.collections = collections;
  await writeRawConfig(home, raw);
  out.write(`Forgot collection '${name}'.\n`);
  return 0;
}

// The cached inventory, soft: list/save use it for match counts and warnings;
// without one they still work (patterns are validated against nothing).
async function readInventorySoft(home) {
  try {
    const raw = await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Run `ninja collection`. Returns the process exit code.
 * @param {string[]} args
 */
export async function collectionCommand(args) {
  const out = process.stdout;
  const err = process.stderr;
  const [sub, ...rest] = args;
  const home = homedir();
  const inventory = await readInventorySoft(home);

  if (sub === undefined || sub === "list") {
    const { collections } = await loadCollections(home);
    return listCommand(out, collections, rest[0], inventory);
  }
  if (sub === "save") return saveCommand(out, err, home, rest, inventory);
  if (sub === "forget") return forgetCommand(out, err, home, rest);

  err.write(`Unknown collection subcommand: ${sub}\n`);
  err.write("Try: ninja collection list [name] | save <name> <skill|prefix*> … | forget <name>\n");
  return 2;
}
