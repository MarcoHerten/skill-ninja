// Shared body-extraction + content-hash primitives. `add`, `diff`, and the
// inventory (hash-based duplicate detection, CONTEXT.md "Duplicate") all hash the
// SAME bytes — the Skill body after the `---` frontmatter block (ADR-0005) — so
// one definition lives here and the three callers share it.

import { createHash } from "node:crypto";

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

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
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return text; // no opening fence -> whole content is the body
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return text; // never closes -> whole content (lenient)
  return lines.slice(closeIdx + 1).join("\n");
}

/** SHA-256 of a SKILL.md's body (the content-hash contract `add`/`diff` use). */
export const bodyHash = (text) => sha256(extractBody(text));
