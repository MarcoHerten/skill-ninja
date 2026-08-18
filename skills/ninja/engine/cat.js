// `ninja cat` — the category catalog (Issue #10).
//
// Categories are DATA ON THE SKILL, not a mapping in a script: a `category`
// frontmatter stamp (written by `cat assign`, carried through `add`), captured
// by `init` into the cached inventory (schema v3) alongside the skill's
// `description`. The catalog is a VIEW over that cache — computed on demand,
// never a second artifact to keep in sync (SPEC.md, "No anti-patterns"; the
// hand-maintained name→category dict of the reference implementation is the
// anti-pattern this replaces).
//
// Two faces:
// - `cat [<term>]` — the catalog view: skills grouped under category headings
//   (vocabulary order first, then custom categories, "Uncategorized" last),
//   each entry `name [tier] — description`. A term filters to categories whose
//   name contains it (case-insensitive). Reads the cache; never re-scans.
// - `cat assign <name> <category>` — stamp the category onto the STORED copy
//   (frontmatter-only edit: the body, version, and content hash are untouched,
//   ADR-0005) and commit. Only stored skills are writable — External skills
//   belong to skills.sh (ADR-0007).
//
// The grouping/tier/description helpers are exported because `page` renders
// the browser catalog with the SAME code — one implementation, no divergent
// copy (the pattern `page` already follows with `status`'s groupSkills).

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { inventoryPath, parseFrontmatter } from "./inventory.js";
import { quoteValue } from "./hash.js";
import { groupSkills, isPersonal, plural } from "./status.js";
import { tryCommit, tryPush } from "./git.js";

// The default category vocabulary, generalized from the reference taxonomy
// (Issue #10). Config `categories: [...]` replaces it wholesale; stamps are
// free-form either way — a category outside the vocabulary renders as its own
// group rather than erroring.
export const DEFAULT_CATEGORIES = [
  "Strategy & Management",
  "Marketing & Social",
  "Content & Writing",
  "Design & Documents",
  "Education & Specialties",
  "Meta & Agent Tooling",
];

// The heading unstamped skills group under — always rendered last.
export const UNCATEGORIZED = "Uncategorized";

// The effective vocabulary: the configured list when one is set — any array,
// including an explicitly empty one, replaces the defaults wholesale (ADR-0013);
// null/absent means the engine defaults. Exported because `page` and
// `config show` resolve the same vocabulary — one rule, three consumers.
export function resolveVocabulary(config) {
  return Array.isArray(config?.categories) ? config.categories : DEFAULT_CATEGORIES;
}

// The first non-empty string value of `key` among the occurrences (scan
// order). Used for the two per-group frontmatter signals the catalog shows —
// category and description; occurrences of one skill rarely disagree, and when
// they do, the first scanned wins.
function firstStringValue(occurrences, key) {
  for (const occ of occurrences) {
    const v = occ?.[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// A group's category (null → the catalog's Uncategorized bucket).
function groupCategory(group) {
  return firstStringValue(group.occurrences, "category");
}

// A group's description: the catalog's one-liner per skill.
export function groupDescription(occurrences) {
  return firstStringValue(occurrences, "description");
}

// A group's tier badge: External when skills.sh owns any occurrence (lockfile
// attribution, ADR-0007), else Personal when any occurrence matches the
// ADR-0004 heuristic, else none. Exported for `page` (same badge, same rule).
export function groupTier(occurrences, store) {
  if (occurrences.some((o) => o.tier === "external")) return "External";
  if (occurrences.some((o) => isPersonal(o, store))) return "Personal";
  return null;
}

/**
 * Group name-groups (status.js `groupSkills` output) into category sections.
 * Order: the vocabulary's order first (only categories that have skills), then
 * remaining categories alphabetically, "Uncategorized" always last.
 *
 * @param {Array<object>} groups Output of `groupSkills`.
 * @param {string[]} [vocabulary] Category order (defaults: DEFAULT_CATEGORIES).
 * @returns {Array<{category: string, skills: Array<object>}>}
 */
export function groupByCategory(groups, vocabulary = DEFAULT_CATEGORIES) {
  const sections = new Map();
  for (const g of groups) {
    const category = groupCategory(g) ?? UNCATEGORIZED;
    if (!sections.has(category)) sections.set(category, []);
    sections.get(category).push(g);
  }
  const vocabRank = (cat) => {
    const idx = vocabulary.indexOf(cat);
    return idx === -1 ? vocabulary.length : idx;
  };
  return [...sections.entries()]
    .map(([category, skills]) => ({ category, skills }))
    .sort((a, b) => {
      if (a.category === UNCATEGORIZED) return 1;
      if (b.category === UNCATEGORIZED) return -1;
      const d = vocabRank(a.category) - vocabRank(b.category);
      return d !== 0 ? d : a.category.localeCompare(b.category);
    });
}

/**
 * Render the cached inventory as the catalog report.
 *
 * @param {object} inventory The cached inventory (schema v3).
 * @param {{store?:string|null, categories?:string[]|null}} config
 * @param {string|null} [filter] Category filter term (case-insensitive
 *   substring) or null for the full catalog.
 * @returns {string} The report, with a trailing newline.
 */
export function renderCatalog(inventory, config, filter = null) {
  const store = config?.store ?? null;
  const vocabulary = resolveVocabulary(config);
  const allSections = groupByCategory(groupSkills(inventory.skills ?? []), vocabulary);

  const sections = filter
    ? allSections.filter((s) => s.category.toLowerCase().includes(filter.toLowerCase()))
    : allSections;

  const categorized = sections.filter((s) => s.category !== UNCATEGORIZED);
  const uncat = sections.find((s) => s.category === UNCATEGORIZED);
  const skillCount = sections.reduce((n, s) => n + s.skills.length, 0);
  const uncatCount = uncat ? uncat.skills.length : 0;

  const lines = ["Skill Ninja catalog"];
  if (inventory.generatedAt) lines.push(`(inventory from ${inventory.generatedAt})`);
  if (filter) lines.push(`(filtering: ${filter})`);

  // "category" pluralizes irregularly — the shared plural() helper only
  // appends "s", so this word is formed here.
  const categoryWord = categorized.length === 1 ? "category" : "categories";
  lines.push(
    "",
    `${plural(skillCount, "skill")} across ${categorized.length} ${categoryWord}, ` +
      `${plural(uncatCount, "uncategorized skill")}.`,
  );

  if (filter && sections.length === 0) {
    const present = allSections.map((s) => s.category);
    lines.push(
      "",
      `No category matching '${filter}'.`,
      present.length
        ? `Categories present: ${present.join(", ")}.`
        : "(no skills in the inventory yet)",
    );
    return lines.join("\n") + "\n";
  }

  if (sections.length === 0) {
    lines.push("", "(no skills found)");
    return lines.join("\n") + "\n";
  }

  for (const section of sections) {
    lines.push("", `${section.category} (${section.skills.length}):`);
    for (const g of section.skills) {
      const tier = groupTier(g.occurrences, store);
      const badge = tier ? ` [${tier}]` : "";
      const description = groupDescription(g.occurrences) ?? "(no description)";
      lines.push(`  ${g.name}${badge} — ${description}`);
    }
  }

  return lines.join("\n") + "\n";
}

// --- cat assign ---------------------------------------------------------------

// Set exactly one `category:` line in the frontmatter, leaving every other
// line and the whole body byte-identical. Replaces an existing category line
// in place; otherwise inserts it after the `name:` line (or right after the
// opening fence). A stored file without any frontmatter gets a minimal block
// prepended (pathological — `add` always stamps — but assign must not crash).
function stampCategoryLine(text, category) {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return `---\ncategory: ${quoteValue(category)}\n---\n` + text;
  }
  const closeIdx = lines.indexOf("---", 1);
  if (closeIdx === -1) {
    return `---\ncategory: ${quoteValue(category)}\n---\n` + text;
  }
  const fm = lines.slice(1, closeIdx);
  const line = `category: ${quoteValue(category)}`;
  const existing = fm.findIndex((l) => /^category\s*:/.test(l));
  if (existing !== -1) {
    fm[existing] = line;
  } else {
    const nameIdx = fm.findIndex((l) => /^name\s*:/.test(l));
    fm.splice(nameIdx === -1 ? 0 : nameIdx + 1, 0, line);
  }
  return ["---", ...fm, ...lines.slice(closeIdx)].join("\n");
}

// loadConfig with the ENOENT fallback decided by the caller: `assign` treats a
// missing config as an error (null), the view falls back like `status` does.
// Any other error still throws.
async function loadConfigSoft(home, fallback) {
  try {
    return await loadConfig(home);
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    throw e;
  }
}

async function assignCommand(args, out, err) {
  const [name, category, ...rest] = args;
  const usage = "Try: ninja cat assign <name> <category>";
  if (rest.length > 0) {
    err.write(`Unexpected argument: ${rest[0]}\n${usage}\n`);
    return 2;
  }
  if (!name || category === undefined) {
    err.write(`assign needs a skill name and a category.\n${usage}\n`);
    return 2;
  }
  if (name.includes("/")) {
    err.write(`Invalid skill name: '${name}'\n`);
    return 2;
  }
  if (category.trim() === "") {
    err.write("The category must not be empty.\n");
    return 2;
  }

  const home = homedir();
  const config = await loadConfigSoft(home, null);
  if (!config) {
    err.write("No Skill Ninja configuration found. Run `ninja init` first.\n");
    return 2;
  }
  if (!config.store) {
    err.write("No canonical store configured (set `store` in ~/.skill-ninja/config.json).\n");
    return 2;
  }

  // Only the stored copy is writable — a loose copy in an agent root is never
  // touched (ADR-0007 ownership; `add`/`doctor` ingest loose skills first).
  const storedFile = join(config.store, name, "SKILL.md");
  if (!existsSync(storedFile)) {
    err.write(
      `No skill '${name}' found in the canonical store (${config.store}). ` +
        "Categories are stamped on the stored copy — run `ninja add` first.\n",
    );
    return 2;
  }

  // Free-form stamps are allowed; a value outside the vocabulary still gets a
  // warning so typos don't silently fragment the catalog (warns, never blocks).
  const vocabulary = resolveVocabulary(config);
  if (!vocabulary.some((c) => c.toLowerCase() === category.toLowerCase())) {
    out.write(`Warning: '${category}' is not in the configured category vocabulary ` +
      `(${vocabulary.join(", ")}). It is stamped anyway.\n`);
  }

  const text = await readFile(storedFile, "utf8");
  const current = parseFrontmatter(text).category;
  if (current === category) {
    out.write(`Already categorized '${name}' as '${category}' — nothing changed.\n`);
    return 0;
  }

  await writeFile(storedFile, stampCategoryLine(text, category), "utf8");

  // Metadata-only change: version/hash/body untouched (ADR-0005 hashes the
  // body), so no CHANGELOG entry — the store's git log is the record.
  const committed = tryCommit(config.store, [name], `categorize ${name}`);
  const pushed = committed ? tryPush(config.store) : false;

  out.write(`Categorized '${name}' as '${category}'.\n`);
  out.write(`Wrote category stamp to ${storedFile}.\n`);
  if (committed) out.write(`Committed to ${config.store}.\n`);
  if (pushed) out.write(`Pushed to the private remote.\n`);
  return 0;
}

/**
 * Run `ninja cat`. Returns the process exit code.
 * @param {string[]} args
 */
export async function catCommand(args) {
  const out = process.stdout;
  const err = process.stderr;

  if (args[0] === "assign") {
    return assignCommand(args.slice(1), out, err);
  }

  const filter = args[0];
  if (args.length > 1 || (filter !== undefined && filter.startsWith("--"))) {
    err.write(`Unknown cat argument: ${filter}\n`);
    err.write("Try: ninja cat [category] | ninja cat assign <name> <category>\n");
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
          "Run `ninja init` to scan your skills, then re-run `cat`.\n",
      );
      return 0;
    }
    throw e;
  }
  const inventory = JSON.parse(raw);

  // Config feeds the tier badges (the canonical store path). Same fallback as
  // `status` when the config has vanished since init.
  const config = await loadConfigSoft(home, { store: null });

  out.write(renderCatalog(inventory, config, filter ?? null));
  return 0;
}
