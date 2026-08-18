// Shared ADR-0005 primitives: frontmatter splitting, body extraction, the
// content hash, and stamp serialization. `add`, `diff`, `ingest`, and the
// inventory (hash-based duplicate detection, CONTEXT.md "Duplicate") all hash
// the SAME bytes — the Skill body after the `---` frontmatter block — and write
// the SAME stamp block, so one definition of each lives here and every caller
// shares it.

import { createHash } from "node:crypto";

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Split content into its `---`-delimited frontmatter block and body, exactly as
 * defined by ADR-0005. Returns null when there is no parseable frontmatter:
 * the opening `---` must be the exact first line and a closing `---` line must
 * exist. One shared parse so body extraction and frontmatter inspection can
 * never disagree about where the block ends.
 *
 * @param {string} text
 * @returns {{fm: string[], body: string[]}|null}
 */
export function splitFrontmatter(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const closeIdx = lines.indexOf("---", 1);
  if (closeIdx === -1) return null;
  return { fm: lines.slice(1, closeIdx), body: lines.slice(closeIdx + 1) };
}

/**
 * Extract the Skill body — the markdown content AFTER the `---` frontmatter
 * block — exactly as defined by ADR-0005 so the content hash is reproducible.
 *
 * Rule: if the content starts with a `---` fence line, the body is everything
 * after the closing `---` fence line; otherwise the body is the whole content.
 * If a frontmatter block never closes, the whole content is the body (lenient).
 *
 * @param {string} text
 * @returns {string}
 */
export function extractBody(text) {
  if (typeof text !== "string") return "";
  const split = splitFrontmatter(text);
  if (!split) return text; // no (or unclosed) frontmatter -> whole content
  return split.body.join("\n");
}

/** SHA-256 of a SKILL.md's body (the content-hash contract `add`/`diff` use). */
export const bodyHash = (text) => sha256(extractBody(text));

// Quote a free-text stamp value (provenance.from / relation / description /
// category), escaping inner double quotes so the YAML stays one scalar.
// Exported because `cat assign` writes a `category:` line with the exact same
// quoting, and the two must never drift.
export const quoteValue = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const quote = quoteValue;

/**
 * Serialize the ADR-0005 stamp block (deterministic key order) as a complete
 * `---`-fenced frontmatter, optionally followed by extra verbatim frontmatter
 * lines (the wrap's preserved fields, ADR-0010). One serializer shared by
 * `add`'s stamping and ingest's prompt wrapping so the two can never drift.
 *
 * @param {object} stamps {name, description?, category?, version, updated,
 *   hash, provenance: {source, from, imported, derived_from, relation}}
 *   `category` (Issue #10) is emitted only when set — a skill without one
 *   carries no empty line.
 * @param {string[]} [extraLines] Verbatim lines appended after the provenance
 *   block (before the closing fence).
 * @returns {string} The fenced frontmatter (ending in a newline).
 */
export function serializeStamps(stamps, extraLines = []) {
  const p = stamps.provenance;
  const derivedFrom = p.derived_from === null || p.derived_from === undefined ? "null" : p.derived_from;
  const relation = p.relation === null || p.relation === undefined ? "null" : quote(p.relation);
  const description = stamps.description ? `description: ${quote(stamps.description)}\n` : "";
  const category = stamps.category ? `category: ${quote(stamps.category)}\n` : "";
  const extra = extraLines.length > 0 ? extraLines.join("\n") + "\n" : "";
  return (
    "---\n" +
    `name: ${stamps.name}\n` +
    description +
    category +
    `version: ${stamps.version}\n` +
    `updated: ${stamps.updated}\n` +
    `hash: ${stamps.hash}\n` +
    "provenance:\n" +
    `  source: ${p.source}\n` +
    `  from: ${quote(p.from)}\n` +
    `  imported: ${p.imported}\n` +
    `  derived_from: ${derivedFrom}\n` +
    `  relation: ${relation}\n` +
    extra +
    "---\n"
  );
}
