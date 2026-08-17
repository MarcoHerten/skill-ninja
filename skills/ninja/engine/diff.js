// Minimal line-diff + body-extraction helpers, plus the standalone `diff`
// command (Issue #5 / T5). `add` shows an INLINE diff when re-adding a skill
// whose name already exists in the store; the `diffCommand` here is the
// standalone "what changed?" surface, built on the same primitives. ADR-0005
// defines the body / content-hash rule both rely on.
//
// No external diff dependency — a classic LCS line diff over split lines.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { parseFrontmatter } from "./inventory.js";
import { resolveSkillFromSource } from "./source.js";
import { extractBody, sha256 } from "./hash.js";

// extractBody + sha256 are shared from ./hash.js (ADR-0005 body/content-hash
// contract) so `add`, `diff`, and the inventory hash the same bytes.

/**
 * Classic LCS line diff. Returns a list of entries describing how to turn
 * `oldLines` into `newLines`: {type:'ctx'|'del'|'add', text}.
 *
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {Array<{type:string, text:string}>}
 */
export function lineDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = LCS length of oldLines[i:] and newLines[j:]
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: "ctx", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: oldLines[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ type: "del", text: oldLines[i++] });
  while (j < m) out.push({ type: "add", text: newLines[j++] });
  return out;
}

/**
 * Render a line diff of two text blobs as a compact unified-style block: removed
 * lines prefixed `-`, added lines prefixed `+`. Only changed lines (and the
 * lines around them, see `context`) are shown to keep output readable. Returns a
 * string with no leading/trailing newline guards beyond the joined lines.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {object} [opts]
 * @param {number} [opts.context=1] Unchanged lines of context around each change.
 * @returns {string}
 */
export function renderDiff(oldText, newText, { context = 1 } = {}) {
  const oldLines = (oldText ?? "").split(/\r?\n/);
  const newLines = (newText ?? "").split(/\r?\n/);
  const entries = lineDiff(oldLines, newLines);

  // Mark which entries are changes, then keep changes plus `context` neighbours.
  const keep = new Array(entries.length).fill(false);
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].type !== "ctx") {
      for (let c = k - context; c <= k + context; c++) {
        if (c >= 0 && c < entries.length) keep[c] = true;
      }
    }
  }
  const out = [];
  for (let k = 0; k < entries.length; k++) {
    if (!keep[k]) continue;
    const e = entries[k];
    const prefix = e.type === "add" ? "+" : e.type === "del" ? "-" : " ";
    out.push(`${prefix} ${e.text}`);
  }
  return out.join("\n");
}

// --- standalone `diff` command (Issue #5 / T5) --------------------------------

// sha256 is imported from ./hash.js.
// First 8 hex chars + ellipsis — readable in a header, enough to identify.
// Shared with ingest's cluster report (every loser line shows its hash).
export const shortHash = (h) => (h ? h.slice(0, 8) + "\u2026" : "unknown");

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function parseDiffArgs(args) {
  const positional = [];
  for (const a of args) {
    if (a.startsWith("--")) return { error: `unknown option: ${a}` };
    positional.push(a);
  }
  return { positional };
}

// Distinct added / removed / changed counts from a line-diff's entries. A
// "changed" line is a removed line IMMEDIATELY followed by an added line (a
// modification); the remaining dels are pure removals and the remaining adds
// pure additions. (Issue #5: the summary must count added / changed / removed
// distinctly.) Defined verbatim from the entries so a caller can reason about
// the count for a known input. Exported for ingest's needs-decision
// side-by-side (diff stats between divergent variants).
export function summarizeChanges(entries) {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (e.type === "del" && entries[k + 1] && entries[k + 1].type === "add") {
      changed += 1;
      k += 1; // consume the paired add below
    } else if (e.type === "add") {
      added += 1;
    } else if (e.type === "del") {
      removed += 1;
    }
  }
  return { added, removed, changed };
}

/**
 * Run `ninja diff <name> <candidate>`. Compares the stored (baseline)
 * Skill <name> against a candidate version (a folder, a bare SKILL.md, or a
 * repo/URL — resolved with the same source resolver `add` uses). Reports a
 * header naming both sides with their content hashes, a verdict (DIFFERS /
 * MATCHES), a change summary (added / removed / changed), and a unified diff
 * block. The store copy is the baseline, so a candidate is required. Returns the
 * process exit code.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function diffCommand(args) {
  const out = process.stdout;
  const err = process.stderr;
  const home = homedir();

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
  const store = config.store;
  if (!store) {
    err.write("No canonical store configured (set `store` in ~/.skill-ninja/config.json).\n");
    return 2;
  }

  const parsed = parseDiffArgs(args);
  if (parsed.error) {
    err.write(`${parsed.error}\n`);
    err.write("Try: ninja diff <name> <candidate>\n");
    return 2;
  }
  const [name, candidate] = parsed.positional;

  // The store copy IS the canonical baseline, so a full content diff needs a
  // candidate to compare against. Guide the user plainly when one is absent.
  if (!name) {
    out.write(
      "`diff` compares a stored skill against a candidate version.\n" +
        "Usage: ninja diff <name> <candidate>\n" +
        "  <name>      a skill already in the canonical store (the baseline).\n" +
        "  <candidate> a folder, a bare SKILL.md, or a repo/URL — the version to compare\n" +
        "              (e.g. the v2 a friend sent, or an upstream repo).\n" +
        "The store copy is the baseline, so a candidate is required to see what changed.\n",
    );
    return 2;
  }
  if (!candidate) {
    out.write(
      `Skill Ninja diff needs a candidate to compare '${name}' against — the store copy is\n` +
        `the baseline, so there is nothing to diff without one.\n` +
        `Usage: ninja diff ${name} <candidate>\n` +
        "  <candidate> = a folder, a bare SKILL.md, or a repo/URL (e.g. an updated copy, or an upstream repo).\n",
    );
    return 2;
  }

  // Stored (baseline) side.
  const storedFile = join(store, name, "SKILL.md");
  if (!existsSync(storedFile)) {
    err.write(
      `Skill '${name}' is not in the canonical store at ${store}.\n` +
        `Run \`ninja add ${name} <source>\` to store it first, then diff.\n`,
    );
    return 2;
  }
  const storedText = await readFile(storedFile, "utf8");
  const storedStamps = parseFrontmatter(storedText);
  const storedBody = extractBody(storedText);
  const storedHash = sha256(storedBody);

  // Candidate (incoming) side — same resolver `add` uses, so a repo/URL
  // candidate IS the upstream/external version.
  let candidateContent;
  try {
    ({ content: candidateContent } = await resolveSkillFromSource(candidate));
  } catch (e) {
    err.write(`${e.message}\n`);
    return 2;
  }
  const incomingBody = extractBody(candidateContent);
  const incomingHash = sha256(incomingBody);

  const storedVersion = storedStamps.version ?? "unknown";
  const matches = storedHash === incomingHash;

  out.write(
    `diff '${name}': stored version ${storedVersion} (hash ${shortHash(storedHash)}) ` +
      `vs incoming ${candidate} (hash ${shortHash(incomingHash)}) ` +
      `\u2192 content ${matches ? "MATCHES" : "DIFFERS"}.\n`,
  );

  if (matches) {
    out.write("No content changes; the incoming version matches the stored version.\n");
    return 0;
  }

  const entries = lineDiff(storedBody.split(/\r?\n/), incomingBody.split(/\r?\n/));
  const { added, removed, changed } = summarizeChanges(entries);
  out.write(
    `Summary: ${plural(added, "line")} added, ${plural(removed, "line")} removed, ${plural(changed, "line")} changed.\n`,
  );
  out.write("\n" + renderDiff(storedBody, incomingBody) + "\n");
  return 0;
}
