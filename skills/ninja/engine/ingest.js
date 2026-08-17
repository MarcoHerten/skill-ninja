// `ninja ingest <dir>` — the v1.1 bulk pipeline's dry-run analysis phase
// (ADR-0009). Walks a messy source directory and classifies every candidate as
// a skill package (any packaging), a prompt document, or junk — each with a
// one-line reason and its normalized identity. The dry run is strictly
// read-only: nothing inside (or outside) the analyzed directory is modified;
// storing winners is `--apply`'s job (a later build).
//
// CONTEXT.md: Candidate, Ingest, Skill, Wrap. ADR-0009: classification rules,
// inside/outside edge ("files inside a recognized package are bundled assets
// and always travel with it").

import { readdir, readFile, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

import { parseFrontmatter } from "./inventory.js";
import { bodyHash, extractBody, serializeStamps, splitFrontmatter } from "./hash.js";

const today = () => new Date().toISOString().slice(0, 10);

// Directories never descended into (never candidates, often huge) — the same
// rule init's scan applies (engine/inventory.js).
const SKIP_DIRS = new Set([".git", "node_modules"]);

// --- identity normalization (ADR-0009) ----------------------------------------

/**
 * Normalize a folder/file stem or frontmatter name into a candidate's identity:
 * Unicode NFC (macOS export filenames are NFD), version suffixes and copy
 * markers stripped (`-v4`, `Kopie`, ` 2`, semver/date codes), special characters
 * slugged (em-dashes, parentheses, `×` become `-`). Case-folds so casing
 * variants cluster together.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeIdentity(raw) {
  let s = String(raw ?? "").normalize("NFC").trim();
  // Version/copy suffixes, stripped repeatedly from the end (`Name 2 Kopie` ->
  // `Name 2` -> `Name`). Separators may be space, `-`, `_`, or a dash.
  const SUFFIX = /[-_ \u2014\u2013](?:kopie|copy)(?:[-_ \u2014\u2013]\d+)?$/i;
  const VNUMBER = /[-_ \u2014\u2013]v\d+$/i;
  const SEMVER = /[-_ \u2014\u2013]\d+\.\d+(\.\d+)?$/;
  const ISO_DATE = /[-_ \u2014\u2013]\d{4}-\d{2}-\d{2}$/;
  const DE_DATE = /[-_ \u2014\u2013]\d{2}-\d{2}-\d{4}$/;
  const COMPACT_DATE = /[-_ \u2014\u2013]\d{8}$/;
  const COPY_NUMBER = / \d+$/; // macOS copy marker uses a space (`Name 2`)
  const PAREN_NUMBER = /\s*\(\d+\)\s*$/; // browser/zip copy marker `Name (2)`
  const patterns = [SUFFIX, VNUMBER, SEMVER, ISO_DATE, DE_DATE, COMPACT_DATE, COPY_NUMBER, PAREN_NUMBER];
  let prev = null;
  while (prev !== s) {
    prev = s;
    for (const p of patterns) s = s.replace(p, "").trim();
  }
  // Slug: lowercase, every run of non-alphanumerics becomes one `-`.
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

// --- skill-file recognition ---------------------------------------------------

// A skill file is `SKILL.md` or a non-standard sibling name carrying the same
// intent: `SKILL-UPDATED.md`, `SKILL_artemis_v3.md`, `kalliope-SKILL.md`
// (ADR-0009).
export function isSkillFileName(name) {
  const m = name.toLowerCase().match(/^(.*)\.md$/);
  if (!m) return false;
  const stem = m[1];
  return stem === "skill" || /^skill[-_]/.test(stem) || /[-_]skill$/.test(stem);
}

// --- classification -----------------------------------------------------------

// Classifications a candidate can receive (CONTEXT.md: Candidate).
const SKILL = "skill package";
const PROMPT = "prompt document";
const JUNK = "junk";

// The archive extensions that may wrap a zip's real stem (`foo.skill.zip` ->
// `foo`).
const ARCHIVE_EXTS = ["zip", "skill"];

function stemWithoutArchiveExts(name) {
  let stem = name;
  let ext = null;
  for (;;) {
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) break;
    ext = stem.slice(dot + 1).toLowerCase();
    if (!ARCHIVE_EXTS.includes(ext)) break;
    stem = stem.slice(0, dot);
  }
  return stem;
}

// Files never treated as candidates even though they are `.md` — export
// meta/navigation artifacts (ADR-0009 junk list).
function metaFileReason(name) {
  const stem = name.toLowerCase().replace(/\.md$/, "");
  if (/^readme/.test(stem)) return "meta/navigation file (readme)";
  if (stem === "agents") return "meta/navigation file (agents)";
  if (/^(index|navigator|dashboard|lint)/.test(stem)) return "meta/navigation file (index/navigation artifact)";
  if (/^(\d+[_-])?start/.test(stem)) return "meta/navigation file (start-here)";
  return null;
}

function junkReason(name) {
  if (name === ".DS_Store") return "macOS metadata file";
  if (/\.bak(\.|$)/i.test(name)) return "backup file";
  const meta = metaFileReason(name);
  if (meta) return meta;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "(no extension)";
  return `not a skill package or prompt document (${ext})`;
}

// Zip magic bytes (local header, empty archive, spanned marker) — archives are
// recognized by content, never by extension (ADR-0009).
function isZipMagic(buf) {
  if (!buf || buf.length < 4) return false;
  const two = buf[0] === 0x50 && buf[1] === 0x4b;
  return two && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

// Reads a candidate's SKILL.md text; `null` when it cannot be read.
async function readSkillText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Frontmatter health for the needs-review marking: trivial delimiter damage
// (a damaged opening fence, or an unclosed one) — ADR-0009 says such items stay
// skill packages, marked needs-review, not junk. Returns the damage as a reason
// fragment, or false when the frontmatter is healthy/absent.
function frontmatterDamage(text) {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/);
  const first = (lines[0] ?? "").trim();
  if (/^-{2,}$/.test(first) && first !== "---") {
    // Damaged opening fence — only "frontmatter intent" if a closing fence or
    // `key: value` lines follow.
    const rest = lines.slice(1, 30);
    const looksLikeFm =
      rest.some((l) => l.trim() === "---") || rest.some((l) => /^[A-Za-z][\w-]*\s*:/.test(l));
    return looksLikeFm ? "frontmatter opening fence damaged" : false;
  }
  if (first === "---") {
    return lines.slice(1).some((l) => l.trim() === "---") ? false : "frontmatter never closes";
  }
  return false;
}

// Identity of a skill package: the frontmatter `name` when parseable, else the
// normalized stem (ADR-0009 cluster identity).
function packageIdentity(fmName, stem) {
  const raw = typeof fmName === "string" && fmName.trim() ? fmName : stem;
  return normalizeIdentity(raw) || "unnamed";
}

// One skill-package candidate, shared by every packaging form (folder / archive
// / bare file): identity from the SKILL.md's frontmatter (stem fallback),
// plus the packaging reason and the needs-review marking on delimiter damage.
function skillItem({ relPath, stem, text, packagingReason }) {
  const fm = text !== null ? parseFrontmatter(text) : {};
  const damage = frontmatterDamage(text);
  return {
    classification: SKILL,
    relPath,
    identity: packageIdentity(fm.name, stem),
    reason: packagingReason + (damage ? `; ${damage}` : ""),
    needsReview: damage || undefined,
  };
}

// Classify one archive: list its members read-only (`unzip -Z1`, nothing is
// extracted), filter `__MACOSX`/`.DS_Store`, and look for a skill file at any
// nesting level or under any non-standard name.
function classifyArchive(path, relPath) {
  let names;
  try {
    names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith("/"))
      .filter((s) => !s.startsWith("__MACOSX/") && !/__MACOSX\//.test(s))
      .filter((s) => !s.split("/").includes(".DS_Store"));
  } catch {
    return { classification: JUNK, relPath, reason: "unreadable archive" };
  }
  const member = names.find((n) => isSkillFileName(n.split("/").pop()));
  if (!member) {
    return { classification: JUNK, relPath, reason: "archive without a SKILL.md" };
  }
  let text = null;
  try {
    text = execFileSync("unzip", ["-p", path, member], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    text = null;
  }
  return skillItem({
    relPath,
    stem: stemWithoutArchiveExts(relPath),
    text,
    packagingReason: `zip archive (content-detected) with skill file '${member}'`,
  });
}

// --- prompt wrapping (ADR-0010) ------------------------------------------------

// The wrapped SKILL.md carries the ADR-0005 stamps; any frontmatter the prompt
// document already has is preserved verbatim (it is harmless YAML and keeps
// information) — except the stamped keys themselves.
const STAMPED_KEYS = new Set(["name", "version", "updated", "hash", "provenance"]);

// The document's own frontmatter lines, verbatim; [] when it has none. Stamped
// keys (and their indented continuation lines) are dropped — the stamps win —
// everything else (blank lines included, ADR-0010 "preserved verbatim") stays
// exactly as written. Uses the shared splitFrontmatter parse so what counts as
// frontmatter here can never disagree with what extractBody treats as body.
function keptFrontmatterLines(content) {
  const split = splitFrontmatter(content);
  if (!split) return [];
  const kept = [];
  let dropping = false;
  for (const line of split.fm) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:/);
    if (m) {
      dropping = STAMPED_KEYS.has(m[1]);
      if (!dropping) kept.push(line);
    } else if (!dropping) {
      kept.push(line); // continuation or blank — original layout survives
    }
  }
  return kept;
}

/**
 * Deterministically wrap a prompt document into its skill form (ADR-0010):
 * `<normalized-stem>/SKILL.md` with ADR-0005 stamps, the document's own
 * frontmatter preserved verbatim, and the original prompt body byte-preserved.
 * `description` is never drafted — wrapped prompts stay needs-review until a
 * later curated pass — and vault/Notion artifacts in the body are carried
 * as-is, never interpreted. Same input => same wrapped form, byte for byte.
 *
 * @param {object} args
 * @param {string} args.content The prompt document's text.
 * @param {string} args.stem The filename stem (identity source).
 * @param {string} args.from The batch label (provenance.from, ADR-0009).
 * @param {string} args.imported The run date (YYYY-MM-DD).
 * @returns {{name: string, skillMd: string}}
 */
export function wrapPromptDocument({ content, stem, from, imported }) {
  const name = normalizeIdentity(stem) || "unnamed";
  const fm = serializeStamps(
    {
      name,
      version: "1.0.0",
      updated: imported,
      hash: bodyHash(content),
      provenance: { source: "received", from, imported, derived_from: null, relation: null },
    },
    keptFrontmatterLines(content),
  );
  return { name, skillMd: fm + extractBody(content) };
}

// Classify a loose file candidate.
async function classifyFile(path, relPath, name, wrapCtx) {
  if (isSkillFileName(name)) {
    return skillItem({
      relPath,
      stem: name.replace(/\.md$/i, ""),
      text: await readSkillText(path),
      packagingReason: "SKILL.md file",
    });
  }
  if (name.toLowerCase().endsWith(".md") && !metaFileReason(name)) {
    const content = (await readSkillText(path)) ?? "";
    const wrapped = wrapPromptDocument({
      content,
      stem: name.replace(/\.md$/i, ""),
      from: wrapCtx.from,
      imported: wrapCtx.imported,
    });
    return {
      classification: PROMPT,
      relPath,
      identity: wrapped.name,
      reason: "markdown without skill structure",
      needsReview: true, // name from a filename, no description — ADR-0010
      wrapped,
    };
  }
  return { classification: JUNK, relPath, reason: junkReason(name) };
}

/**
 * Walk a source directory and classify every candidate in it (ADR-0009).
 * Deterministic order: entries sorted by name, walked depth-first. Files inside
 * a recognized package are bundled assets and never classified individually.
 *
 * @param {string} root The directory to analyze.
 * @returns {Promise<Array<{classification: string, relPath: string, identity?: string, reason: string, needsReview?: true}>>}
 */
export async function analyzeDirectory(root) {
  const candidates = [];
  // The wrap context every prompt candidate wraps with: the batch label
  // (provenance.from, ADR-0009) and the run date (ADR-0005 stamps).
  const wrapCtx = { from: basename(root), imported: today() };

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (entries.length === 0) {
      candidates.push({ classification: JUNK, relPath: prefix, reason: "empty directory" });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = prefix + entry.name;

      // Never candidates, often huge (same rule as init's scan, inventory.js).
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      if (entry.name === "__MACOSX" && entry.isDirectory()) {
        candidates.push({ classification: JUNK, relPath: relPath + "/", reason: "macOS archive metadata" });
        continue;
      }

      if (entry.isDirectory()) {
        // A folder with a skill file directly inside is a package — do not
        // descend (bundled assets travel with it).
        let children;
        try {
          children = await readdir(full, { withFileTypes: true });
        } catch {
          continue;
        }
        const skillChild = children
          .filter((c) => c.isFile())
          .map((c) => c.name)
          .find((n) => isSkillFileName(n));
        if (skillChild) {
          candidates.push(
            skillItem({
              relPath: relPath + "/",
              stem: entry.name,
              text: await readSkillText(join(full, skillChild)),
              packagingReason:
                skillChild === "SKILL.md"
                  ? "folder containing SKILL.md"
                  : `folder containing skill file '${skillChild}'`,
            }),
          );
        } else {
          await walk(full, relPath + "/");
        }
        continue;
      }

      if (entry.isSymbolicLink()) {
        // Follow links like discovery does (a linked package is still a
        // package); a dangling link is junk.
        let target;
        try {
          target = await stat(full);
        } catch (err) {
          const reason = err && err.code === "ENOENT" ? "dangling symlink" : "unreadable symlink";
          candidates.push({ classification: JUNK, relPath, reason });
          continue;
        }
        if (target.isDirectory()) await walk(full, relPath + "/");
        else candidates.push(await classifyFile(full, relPath, entry.name, wrapCtx));
        continue;
      }

      if (entry.isFile()) {
        // Archives are recognized by magic bytes, whatever the extension.
        const handle = await open(full, "r");
        try {
          const { buffer, bytesRead } = await handle.read({
            buffer: Buffer.alloc(4),
            length: 4,
            position: 0,
          });
          if (isZipMagic(buffer.subarray(0, bytesRead))) {
            candidates.push(classifyArchive(full, relPath));
            continue;
          }
        } finally {
          await handle.close();
        }
        candidates.push(await classifyFile(full, relPath, entry.name, wrapCtx));
        continue;
      }
    }
  }

  await walk(root, "");
  return candidates;
}

// --- rendering ----------------------------------------------------------------

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function renderItem(candidate) {
  const label = candidate.needsReview
    ? `${candidate.classification} (needs-review)`
    : candidate.classification;
  // Identity is the cluster key (ADR-0009) — rendered for the classifications
  // that can become skills and cluster; junk never clusters, so it carries none.
  const identity = candidate.identity !== undefined ? ` (identity: ${candidate.identity})` : "";
  let out = `${label.padEnd(28)} ${candidate.relPath}${identity}  ${candidate.reason}`;
  // A prompt candidate renders as the exact wrapped skill `--apply` would store
  // (ADR-0010): the wrapped name plus a preview of the SKILL.md, indented under
  // the candidate line.
  if (candidate.wrapped) {
    // The preview shows the wrapped SKILL.md indented under the candidate; its
    // single trailing newline is trimmed (the report adds its own line break).
    const preview = candidate.wrapped.skillMd
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l === "" ? "" : "      " + l))
      .join("\n");
    out += `\n      wrap preview -> ${candidate.wrapped.name}/SKILL.md\n${preview}`;
  }
  return out;
}

/**
 * Render the dry-run report: a header, one line per candidate, and a summary
 * with counts per classification.
 *
 * @param {string} root The analyzed directory (absolute).
 * @param {Array<object>} candidates The classified candidates.
 * @returns {string}
 */
export function renderReport(root, candidates) {
  const lines = [`Skill Ninja ingest — dry run analysis of ${root}`, "(analysis only: nothing is modified)", ""];
  for (const candidate of candidates) lines.push(renderItem(candidate));
  const skills = candidates.filter((c) => c.classification === SKILL).length;
  const prompts = candidates.filter((c) => c.classification === PROMPT).length;
  const junk = candidates.filter((c) => c.classification === JUNK).length;
  lines.push(
    "",
    `Summary: ${plural(skills, "skill package", "skill packages")}, ` +
      `${plural(prompts, "prompt document", "prompt documents")}, ${junk} junk — ${candidates.length} items.`,
    "Dry run: nothing was modified.",
  );
  return lines.join("\n") + "\n";
}

// --- command ------------------------------------------------------------------

function parseIngestArgs(args) {
  const opts = { dir: undefined };
  for (const a of args) {
    if (a === "--apply") return { error: "`--apply` is not implemented in this build yet (the dry run is the analysis)." };
    if (a.startsWith("--")) return { error: `unknown option: ${a}` };
    if (opts.dir === undefined) opts.dir = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (opts.dir === undefined) return { error: "no directory given" };
  return opts;
}

/**
 * Run `ninja ingest <dir>` (dry run). Returns the process exit code.
 * @param {string[]} args
 */
export async function ingestCommand(args) {
  const opts = parseIngestArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nTry: ninja ingest <dir>\n`);
    return 2;
  }
  let st;
  try {
    st = await stat(opts.dir);
  } catch {
    process.stderr.write(`directory not found: ${opts.dir}\n`);
    return 2;
  }
  if (!st.isDirectory()) {
    process.stderr.write(`not a directory: ${opts.dir}\n`);
    return 2;
  }
  const items = await analyzeDirectory(opts.dir);
  process.stdout.write(renderReport(opts.dir, items));
  return 0;
}
