// The per-skill CHANGELOG.md writer (ADR-0012) — the human-readable history
// projected from the ADR-0005 stamps. One writer shared by `add` (create and
// update paths) and `ingest --apply` (batch winners) so every path renders the
// same entry shapes and obeys the same preservation rules: the store OWNS the
// file (it is never a plain bundled asset), author content is preserved
// verbatim but never merged, entries append chronologically, and the engine
// never drafts editorial prose (maintenance hints stay author/agent judgment).
//
// The file is NOT part of the ADR-0005 content hash — it is a sibling of
// SKILL.md, so `diff`, the comparables check, and duplicate detection are
// unaffected by construction.

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { shortHash } from "./diff.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Every entry opens with the same heading shape (ADR-0012 file layout).
const entryHeading = (version, date) => `## v${version} (${date})\n\n`;

/**
 * Read the author changelog a source directory carries (its package root's
 * `CHANGELOG.md`), or null when there is none. The one read both `add`'s
 * source resolution and ingest's winner staging use — the module that owns
 * the concept owns the read.
 *
 * @param {string} dir A skill's working/source directory.
 * @returns {Promise<string|null>}
 */
export async function readAuthorChangelog(dir) {
  try {
    return await readFile(join(dir, "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
}

// The bootstrap note a pre-feature skill's changelog opens with (created on
// its first changed re-add): earlier history stays where it always was — the
// store's git log — and nothing is retro-fabricated.
export const BOOTSTRAP_NOTE =
  "(This changelog starts here — earlier history lives in the canonical store's git log.)";

/** The generated file header: `# Changelog — <name>`. */
export const changelogHeader = (name) => `# Changelog — ${name}`;

// Drop a leading `# Changelog …` H1 from incoming author content (any casing,
// any suffix after "Changelog"). The generated header replaces the author's
// H1 — everything after it is preserved verbatim.
function stripAuthorH1(text) {
  const s = String(text ?? "");
  const m = s.match(/^#\s+[Cc]hangelog[^\n]*\n?/);
  return m ? s.slice(m[0].length) : s;
}

/**
 * The first-entry shape (`add` of a new skill): version, date, and the
 * provenance projection — from/source always, relation only when set.
 *
 * @param {object} args
 * @param {string} args.version
 * @param {string} args.date ISO date.
 * @param {string} args.source provenance.source.
 * @param {string} args.from provenance.from.
 * @param {string|null} [args.relation]
 * @returns {string}
 */
export function firstEntry({ version, date, source, from, relation = null }) {
  let s = entryHeading(version, date);
  s += `- Ingested by Skill Ninja from "${from}" (source: ${source}).\n`;
  if (relation) s += `- Relation: "${relation}".\n`;
  return s;
}

/**
 * The update-entry shape (`add` re-add with changed content): the distinct
 * change counts (the same summarizeChanges counting `diff` reports), the
 * superseded prior hash (short form), and the relation stamped for this
 * version (which may be a carry-forward) when set.
 *
 * @param {object} args
 * @param {string} args.version
 * @param {string} args.date ISO date.
 * @param {{added: number, removed: number, changed: number}} args.counts
 * @param {string|null} [args.priorHash]
 * @param {string|null} [args.relation]
 * @returns {string}
 */
export function updateEntry({ version, date, counts, priorHash = null, relation = null }) {
  const c = counts ?? { added: 0, removed: 0, changed: 0 };
  let s = entryHeading(version, date);
  s += `- Content update: ${plural(c.added, "line")} added, ${plural(c.removed, "line")} removed, ${plural(c.changed, "line")} changed.\n`;
  if (priorHash) s += `- Supersedes prior content, hash ${shortHash(priorHash)}.\n`;
  if (relation) s += `- Relation: "${relation}".\n`;
  return s;
}

/**
 * The batch-entry shape (`ingest --apply` winner): the batch label as origin,
 * plus the superseded lineage — only when divergent variants lost (identical-
 * copy losers share the winner's hash and supersede nothing).
 *
 * @param {object} args
 * @param {string} args.version
 * @param {string} args.date ISO date.
 * @param {string} args.from The batch label (provenance.from, ADR-0009).
 * @param {string[]} [args.supersededHashes] Full hashes of the superseded variants.
 * @returns {string}
 */
export function batchEntry({ version, date, from, supersededHashes = [] }) {
  let s = entryHeading(version, date);
  s += `- Bulk ingested from batch "${from}" (source: received).\n`;
  if (supersededHashes.length > 0) {
    const hashes = supersededHashes.map(shortHash).join(", ");
    s += `- Won its cluster over ${plural(supersededHashes.length, "superseded variant")}: ${hashes}.\n`;
  }
  return s;
}

/**
 * Assemble the whole file: header, optional author preamble (verbatim, its
 * H1 stripped), optional bootstrap note, then the entries in order. Blocks are
 * separated by exactly one blank line — the same invariant appending keeps.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} [args.authorContent] Incoming CHANGELOG.md content, if any.
 * @param {boolean} [args.bootstrap] Prepend the bootstrap note (no earlier
 *   history exists to carry).
 * @param {string[]} [args.entries] Rendered entries, chronological.
 * @returns {string}
 */
export function renderChangelogFile({ name, authorContent = "", bootstrap = false, entries = [] }) {
  let out = `${changelogHeader(name)}\n`;
  const author = stripAuthorH1(authorContent).replace(/^\n+/, "").replace(/\s+$/, "");
  if (author) out += `\n${author}\n`;
  if (bootstrap) out += `\n${BOOTSTRAP_NOTE}\n`;
  for (const entry of entries) out += `\n${entry}`;
  return out;
}

/**
 * Append an entry to an existing changelog: one blank line between the last
 * block and the new entry, nothing before it rewritten (the append-only
 * guarantee — earlier bytes stay stable).
 *
 * @param {string} existing The stored file's current content.
 * @param {string} entry A rendered entry.
 * @returns {string}
 */
export function appendChangelogEntry(existing, entry) {
  return `${existing.replace(/\s+$/, "")}\n\n${entry}`;
}
