// `ninja find <term>` — search the cached inventory (ADR-0014). `cat <term>`
// filters categories; `find` searches the skills themselves: the term matches
// a skill's name, description, or category (case-insensitive substring).
// Like every view command it reads the cache `init` wrote and never re-scans.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { groupSkills, groupAvailability, availabilityTag } from "./status.js";
import { groupByCategory, groupTier, groupDescription, oneLineDescription, resolveVocabulary } from "./cat.js";
import { configuredCollections, resolveCollectionMembers } from "./collection.js";

/**
 * Run `ninja find`. Returns the process exit code.
 * @param {string[]} args
 */
export async function findCommand(args) {
  const out = process.stdout;
  const err = process.stderr;

  const [term, ...rest] = args;
  if (!term || rest.length > 0) {
    err.write("find needs exactly one search term.\n");
    err.write("Try: ninja find <term> | ninja find @<collection>\n");
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
          "Run `ninja init` to scan your skills, then re-run `find`.\n",
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
    if (e && e.code === "ENOENT") config = { store: null };
    else throw e;
  }

  // `find @<name>` — the collection view (ADR-0015): the member bundle as a
  // flat, tagged list. `find <term>` searches names, descriptions, categories.
  let matches;
  let header;
  if (term.startsWith("@")) {
    const cname = term.slice(1);
    const collections = configuredCollections(config);
    const patterns = collections[cname];
    if (!Array.isArray(patterns)) {
      const present = Object.keys(collections);
      out.write(
        `No collection '${cname}'.` +
          (present.length ? ` Collections present: ${present.join(", ")}.` : " (none saved — try `ninja collection save`).") +
          "\n",
      );
      return 0;
    }
    matches = resolveCollectionMembers(patterns, inventory);
    header = `Skill Ninja find — @${cname}`;
  } else {
    const needle = term.toLowerCase();
    const groups = groupSkills(inventory.skills ?? []);
    matches = groups.filter((g) => {
      const hay = [g.name, groupDescription(g.occurrences) ?? "", ...g.occurrences.map((o) => o.category ?? "")];
      return hay.some((s) => s.toLowerCase().includes(needle));
    });
    header = `Skill Ninja find — '${term}'`;
  }

  const lines = [header];
  if (inventory.generatedAt) lines.push(`(inventory from ${inventory.generatedAt})`);

  if (matches.length === 0) {
    lines.push("", `No skill matching '${term}'.`);
    out.write(lines.join("\n") + "\n");
    return 0;
  }

  // "match" pluralizes irregularly — the shared plural() helper only appends
  // "s", so this word is formed here.
  const matchWord = matches.length === 1 ? "1 match" : `${matches.length} matches`;
  lines.push("", `${matchWord}:`);
  const sections = groupByCategory(matches, resolveVocabulary(config));
  for (const section of sections) {
    lines.push("", `${section.category} (${section.skills.length}):`);
    for (const g of section.skills) {
      const tier = groupTier(g.occurrences, config?.store ?? null);
      const badge = tier ? ` [${tier}]` : "";
      const avail = availabilityTag(groupAvailability(g));
      const availTag = avail ? ` ${avail}` : "";
      const description = oneLineDescription(groupDescription(g.occurrences) ?? "(no description)");
      lines.push(`  ${g.name}${badge}${availTag} — ${description}`);
    }
  }

  out.write(lines.join("\n") + "\n");
  return 0;
}
