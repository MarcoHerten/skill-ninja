// Minimal line-diff + body-extraction helpers. `add` shows an INLINE diff when
// re-adding a skill whose name already exists in the store; T5 (`diff`) reuses
// these for the standalone command. (Issue #3; ADR-0005 defines the body rule.)
//
// No external diff dependency — a classic LCS line diff over split lines.

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
