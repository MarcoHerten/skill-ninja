// `ninja find <term>` — search the cached inventory (ADR-0014). `cat <term>`
// filters categories; `find` searches the skills themselves: the term matches
// a skill's name, description, or category (case-insensitive substring).
// Like every view command it reads the cache `init` wrote and never re-scans.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { loadConfig } from "./config.js";
import { inventoryPath } from "./inventory.js";
import { groupSkills, plural, groupAvailability, availabilityTag } from "./status.js";
import { groupByCategory, groupTier, groupDescription, oneLineDescription, resolveVocabulary } from "./cat.js";

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
    err.write("Try: ninja find <term>\n");
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

  const needle = term.toLowerCase();
  const groups = groupSkills(inventory.skills ?? []);
  const matches = groups.filter((g) => {
    const hay = [g.name, groupDescription(g.occurrences) ?? "", ...g.occurrences.map((o) => o.category ?? "")];
    return hay.some((s) => s.toLowerCase().includes(needle));
  });

  const lines = [`Skill Ninja find — '${term}'`];
  if (inventory.generatedAt) lines.push(`(inventory from ${inventory.generatedAt})`);

  if (matches.length === 0) {
    lines.push("", `No skill matching '${term}'.`);
    out.write(lines.join("\n") + "\n");
    return 0;
  }

  lines.push("", `${plural(matches.length, "match")}:`);
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
