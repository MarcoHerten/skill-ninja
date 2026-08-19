// `ninja collection` — named, personal filters over the cached inventory
// (ADR-0015, amended by ADR-0017). A Collection is a name plus a list of
// patterns (exact skill names or `prefix*` globs) stored at the canonical
// store's root (`<store>/collections.json`) — personal state that travels
// with the store repo: clone on a fresh machine + `init` brings the bundles
// back. Still the deliberate counter-point to ADR-0013's
// categories-as-stamps: one file at the store root is the owner's view, never
// data stamped onto a skill.
//
// The views resolve patterns live: `cat @<name>` (bundle under its content
// categories), `find @<name>`, the page's collection filter, and the
// availability selectors (`--collection <name>`). This module owns the one
// matching rule they all share.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readStoreList, writeStoreList, commitStoreList, COLLECTIONS_FILE } from "./storelists.js";
import { loadConfig } from "./config.js";
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

/**
 * The store-side collections map (ADR-0017): read from
 * `<store>/collections.json`; {} when nothing is saved or no store is
 * configured. Async — every view loads it once up front.
 * @param {{store?:string|null}} config Resolved config.
 * @returns {Promise<object>} The normalized collections map.
 */
export async function readCollections(config) {
  return readStoreList(config?.store ?? null, COLLECTIONS_FILE);
}

async function loadCollections(store) {
  return readStoreList(store, COLLECTIONS_FILE);
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

async function saveCommand(out, err, config, args, inventory) {
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

  const collections = await loadCollections(config.store);
  const members = [...new Set(patterns)];
  const existed = Array.isArray(collections[name]);
  collections[name] = members;
  await writeStoreList(config.store, COLLECTIONS_FILE, collections);
  const committed = commitStoreList(config.store, COLLECTIONS_FILE, `collection save ${name}`);
  out.write(
    `${existed ? "Updated" : "Saved"} collection '${name}' with ${members.length} pattern${members.length === 1 ? "" : "s"}. ` +
      `Filter with: cat @${name}\n`,
  );
  if (committed) out.write(`Committed to ${config.store} (travels with the store repo).\n`);
  return 0;
}

async function forgetCommand(out, err, config, args) {
  const [name] = args;
  if (!name) {
    err.write("forget needs a collection name.\n");
    err.write("Try: ninja collection forget <name>\n");
    return 2;
  }
  const collections = await loadCollections(config.store);
  if (!Array.isArray(collections[name])) {
    err.write(`No collection '${name}'.\n`);
    return 2;
  }
  delete collections[name];
  await writeStoreList(config.store, COLLECTIONS_FILE, collections);
  commitStoreList(config.store, COLLECTIONS_FILE, `collection forget ${name}`);
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

  // The lists live in the store now (ADR-0017) — every subcommand needs the
  // resolved store path. Without a config, `list` still answers (empty); the
  // write paths point at `init`.
  let config;
  try {
    config = await loadConfig(home);
  } catch (e) {
    if (e && e.code === "ENOENT") config = { store: null };
    else throw e;
  }
  if (sub === undefined || sub === "list") {
    const collections = await loadCollections(config.store);
    return listCommand(out, collections, rest[0], inventory);
  }
  if (sub === "save" || sub === "forget") {
    if (!config.store) {
      err.write("No canonical store configured (collections live in the store — run `ninja init` first).\n");
      return 2;
    }
    if (sub === "save") return saveCommand(out, err, config, rest, inventory);
    return forgetCommand(out, err, config, rest);
  }

  err.write(`Unknown collection subcommand: ${sub}\n`);
  err.write("Try: ninja collection list [name] | save <name> <skill|prefix*> … | forget <name>\n");
  return 2;
}
