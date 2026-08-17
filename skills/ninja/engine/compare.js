// Deterministic "comparable skills" pre-check for `add` — ported from the
// personal skill-intake workflow (SPEC.md design reference). Before ingesting,
// surface store skills that belong to the SAME FAMILY under a different name:
// shared name stems (e.g. `landingpage-*` vs `lp-*` — no, stems must actually
// match), overlapping description keywords (same domain/purpose), or identical
// content (the hash signal status also uses). The exact-name case is NOT listed
// here — that is the existing-version diff `add` already shows.
//
// The engine only REPORTS candidates; it never blocks. The semantic comparison
// (trigger collisions, dangling references, variant integrity, and the
// replace/parallel/merge/reject recommendation) is judgment work the skill
// layer does with references/comparison-report.md (SKILL.md, `/ninja add`).

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "./inventory.js";
import { bodyHash } from "./hash.js";

// Tokens too generic to imply a family relationship between two skills.
const STOPWORDS = new Set([
  "skill", "skills", "tool", "tools", "agent", "agents", "assistant",
  "the", "and", "for", "with", "from", "that", "this", "when", "into",
  "der", "die", "das", "und", "fuer", "für", "ein", "eine",
]);

// Lowercase word tokens of length >= 4, stopwords removed.
function tokens(text) {
  const raw = String(text ?? "").toLowerCase().match(/[a-z0-9äöüß][a-z0-9äöüß-]*/g) ?? [];
  return new Set(raw.filter((t) => t.length >= 4 && !STOPWORDS.has(t)));
}

// Name stems: a name split into its constituent words (landingpage-wizard ->
// {landingpage, wizard}). Splits on separators AND camelCase humps.
function nameStems(name) {
  const parts = String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/);
  return new Set(parts.filter((p) => p.length >= 4 && !STOPWORDS.has(p)));
}

const intersection = (a, b) => {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
};

/**
 * Find skills already in the canonical store that are comparable to an incoming
 * skill (same family / similar purpose / identical content), excluding the
 * exact same name (that case is the existing-version diff).
 *
 * Signals (any one qualifies; multiple compose):
 *   - shared name stems (e.g. both names contain "landingpage")
 *   - >= 3 shared description keywords
 *   - identical body content (same content hash)
 *
 * @param {string} store The canonical store path.
 * @param {string} incomingName
 * @param {string|null} incomingDescription Frontmatter description, if any.
 * @param {string} incomingContent The incoming SKILL.md content (for hashing).
 * @returns {Promise<Array<{name: string, dir: string, reasons: string[]}>>}
 *   Matching store skills with plain-language reasons, first-seen order.
 */
export async function findComparableSkills(store, incomingName, incomingDescription, incomingContent) {
  if (!store || !existsSync(store)) return [];

  const incomingStems = nameStems(incomingName);
  const incomingTokens = tokens(incomingDescription);
  const incomingHash = bodyHash(incomingContent);

  const comparables = [];
  let entries;
  try {
    entries = await readdir(store, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name === incomingName) continue; // exact name -> existing-version case
    const skillFile = join(store, e.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let fm = {};
    let text = "";
    try {
      text = await readFile(skillFile, "utf8");
      fm = parseFrontmatter(text);
    } catch {
      continue;
    }

    const reasons = [];
    const sharedStems = intersection(incomingStems, nameStems(fm.name ?? e.name));
    if (sharedStems.size > 0) {
      reasons.push(`shared name stem '${[...sharedStems].sort().join("', '")}'`);
    }
    const sharedTokens = intersection(incomingTokens, tokens(fm.description));
    if (sharedTokens.size >= 3) {
      reasons.push(`${sharedTokens.size} shared description terms`);
    }
    if (incomingHash && bodyHash(text) === incomingHash) {
      reasons.push("identical content");
    }

    if (reasons.length > 0) {
      comparables.push({ name: fm.name ?? e.name, dir: join(store, e.name), reasons });
    }
  }

  return comparables;
}

/**
 * Render the comparables section for `add` stdout: a heading plus one line per
 * candidate (name — reasons), or a "(none found)" line. The engine reports; the
 * decision (replace / parallel / merge / reject) belongs to the user, guided by
 * the skill layer (references/comparison-report.md).
 * @param {Array<{name: string, reasons: string[]}>} comparables
 * @returns {string}
 */
export function renderComparables(comparables) {
  const lines = ["Comparable skills in the store (same family or similar purpose — review before keeping both):"];
  if (!comparables || comparables.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const c of comparables) {
      lines.push(`  - '${c.name}' — ${c.reasons.join("; ")}`);
    }
  }
  return lines.join("\n") + "\n";
}
