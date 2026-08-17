// `ninja ingest <dir>` — the v1.1 bulk pipeline's dry-run analysis phase
// (ADR-0009). Walks a messy source directory, classifies every candidate as a
// skill package (any packaging), a prompt document, or junk, then resolves
// **clusters**: candidates sharing a normalized identity group together, one
// winner per cluster is proposed deterministically (byte-identical members
// collapse by content hash; an explicit version signal orders divergent
// content; the unpacked form beats the archive among identical copies), every
// loser is listed with its hash and the reason it lost, and divergent
// duplicates no rule can order become `needs-decision` with a side-by-side.
// The static safety check runs across all candidates as a report column. The
// dry run is strictly read-only: storing winners is `--apply`'s job (a later
// build).
//
// CONTEXT.md: Candidate, Cluster, Ingest, Skill, Wrap. ADR-0009: cluster
// resolution rules, the inside/outside edge ("files inside a recognized
// package are bundled assets and always travel with it"), losers-not-stored,
// divergent-duplicates policy. ADR-0005: the content hash (the body hash)
// members collapse on.

import { readdir, readFile, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

import { parseFrontmatter } from "./inventory.js";
import { bodyHash, extractBody, serializeStamps, splitFrontmatter, sha256 } from "./hash.js";
import { lineDiff, summarizeChanges, shortHash } from "./diff.js";
import { scanSafety } from "./safety.js";

const today = () => new Date().toISOString().slice(0, 10);

// Directories never descended into (never candidates, often huge) — the same
// rule init's scan applies (engine/inventory.js).
const SKIP_DIRS = new Set([".git", "node_modules"]);

// --- identity normalization (ADR-0009) ----------------------------------------

// Suffixes stripped from a raw name's end, repeatedly (`Name 2 Kopie` ->
// `Name 2` -> `Name`). Separators may be space, `-`, `_`, or a dash. Shared by
// normalizeIdentity (strips them all) and extractVersionSignal (records the
// version-shaped ones before stripping).
const SEP = "[-_ \\u2014\\u2013]";
const RE_SUFFIX = new RegExp(`${SEP}(?:kopie|copy)(?:${SEP}\\d+)?$`, "i");
const RE_VNUMBER = new RegExp(`${SEP}(v\\d+)$`, "i");
const RE_SEMVER = new RegExp(`${SEP}(\\d+\\.\\d+(?:\\.\\d+)?)$`);
const RE_ISO_DATE = new RegExp(`${SEP}(\\d{4}-\\d{2}-\\d{2})$`);
const RE_DE_DATE = new RegExp(`${SEP}(\\d{2}-\\d{2}-\\d{4})$`);
const RE_COMPACT_DATE = new RegExp(`${SEP}(\\d{8})$`);
const RE_COPY_NUMBER = / \d+$/; // macOS copy marker uses a space (`Name 2`)
const RE_PAREN_NUMBER = /\s*\(\d+\)\s*$/; // browser/zip copy marker `Name (2)`

// Copy markers: stripped like the rest, but never a version signal (ADR-0009
// lists them separately — ` 2` is a copy, not a version).
const COPY_PATTERNS = [RE_SUFFIX, RE_COPY_NUMBER, RE_PAREN_NUMBER];
// Version signals in the order they are probed (the shapes are disjoint).
const SIGNAL_DEFS = [
  { re: RE_VNUMBER, kind: "num", parse: (t) => [Number(t.slice(1))] },
  { re: RE_SEMVER, kind: "num", parse: (t) => t.split(".").map(Number) },
  { re: RE_ISO_DATE, kind: "date", parse: (t) => Number(t.replace(/-/g, "")) },
  { re: RE_DE_DATE, kind: "date", parse: (t) => Number(t.slice(6) + t.slice(3, 5) + t.slice(0, 2)) },
  { re: RE_COMPACT_DATE, kind: "date", parse: (t) => Number(t) },
];

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
  const patterns = [...COPY_PATTERNS, RE_VNUMBER, RE_SEMVER, RE_ISO_DATE, RE_DE_DATE, RE_COMPACT_DATE];
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

/**
 * Extract the explicit version signal a raw name carries (ADR-0009 winner
 * priority 2: `v3` < `v4`, semver, date codes — the signals export filenames
 * actually use). Scans right-to-left past copy markers (`Name Kopie v3` still
 * yields `v3`); the rightmost version-shaped suffix wins. Returns a comparable
 * signal — `num` values compare as numeric component arrays (`1.10.0` > `1.9.0`),
 * `date` values as YYYYMMDD integers — or null when the name carries none.
 *
 * @param {string} raw
 * @returns {{kind: "num"|"date", value: number[]|number, text: string}|null}
 */
function extractVersionSignal(raw) {
  let s = String(raw ?? "").normalize("NFC").trim();
  for (;;) {
    let changed = false;
    for (const re of COPY_PATTERNS) {
      const next = s.replace(re, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
    for (const def of SIGNAL_DEFS) {
      const m = s.match(def.re);
      if (m) return { kind: def.kind, value: def.parse(m[1]), text: m[1] };
    }
    for (const def of SIGNAL_DEFS) {
      const next = s.replace(def.re, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
    if (!changed) return null;
  }
}

// A frontmatter `version:` stamp is deliberately NOT a version signal: `add`
// stamps every skill `1.0.0` by default, so a stamp is no evidence of recency —
// on divergent content it could silently pick the stale copy (ADR-0009: "rules
// silently wrong on divergent content is the worst outcome"). Only explicit
// filename signals order variants; everything else is a needs-decision.

// Compare two same-kind signals: -1 / 0 / 1, or null when their kinds differ
// (a date code and a `v3` do not order each other — that cluster is a
// needs-decision, never a silent guess).
function compareSignals(a, b) {
  if (!a || !b || a.kind !== b.kind) return null;
  if (a.kind === "date") return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  const len = Math.max(a.value.length, b.value.length);
  for (let i = 0; i < len; i++) {
    const x = a.value[i] ?? 0;
    const y = b.value[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
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

// Packaging forms, ranked for winner selection (ADR-0009 priority 1: an
// unpacked folder beats an archive — folders are the maintained form; a loose
// skill file is unpacked too). Ranking only ever chooses among byte-identical
// members, where it cannot lose information.
const PACKAGING_RANK = { folder: 0, file: 1, archive: 2 };

// One skill-package candidate, shared by every packaging form (folder / archive
// / bare file): identity from the SKILL.md's frontmatter (stem fallback), the
// packaging reason, the needs-review marking on delimiter damage, plus the
// cluster-resolution facts — the packaging rank, the raw stem (version signals
// live in filenames), and the content hash (ADR-0005 body hash).
function skillItem({ relPath, stem, text, packagingReason, packaging }) {
  const fm = text !== null ? parseFrontmatter(text) : {};
  const damage = frontmatterDamage(text);
  return {
    classification: SKILL,
    relPath,
    identity: packageIdentity(fm.name, stem),
    reason: packagingReason + (damage ? `; ${damage}` : ""),
    needsReview: damage || undefined,
    packaging,
    stem,
    text, // the SKILL.md text (null when unreadable) — the safety scan's input
    bodyText: extractBody(text ?? ""),
    hash: bodyHash(text), // the ADR-0005 content hash — one shared definition
    versionSignal: extractVersionSignal(stem),
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
    packaging: "archive",
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
      packaging: "file",
    });
  }
  if (name.toLowerCase().endsWith(".md") && !metaFileReason(name)) {
    const content = (await readSkillText(path)) ?? "";
    const stem = name.replace(/\.md$/i, "");
    const wrapped = wrapPromptDocument({
      content,
      stem,
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
      content,
      packaging: "file",
      stem,
      bodyText: extractBody(content),
      hash: bodyHash(content), // the ADR-0005 content hash — one shared definition
      versionSignal: extractVersionSignal(stem),
    };
  }
  return { classification: JUNK, relPath, reason: junkReason(name) };
}

/**
 * Walk a source directory and classify every candidate in it (ADR-0009).
 * Deterministic order: entries sorted by name, walked depth-first. Files inside
 * a recognized package are bundled assets and never classified individually.
 * Clusterable candidates (skill packages, prompt documents) carry the facts
 * resolveClusters needs: identity, packaging form, raw stem, body text, content
 * hash, and version signal.
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
              packaging: "folder",
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

// --- cluster resolution (ADR-0009) ---------------------------------------------

// Deterministic member order within a cluster: packaging rank first, then the
// path — never mtime (export mtimes are reset to export time and carry no
// signal).
function memberOrder(a, b) {
  const r = PACKAGING_RANK[a.packaging] - PACKAGING_RANK[b.packaging];
  if (r !== 0) return r;
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

// Why a byte-identical sibling lost to the winner: the packaging rule that
// decided between them (or the plain collapse note when the form is equal).
function identicalLossReason(winner, loser) {
  if (winner.packaging === "folder" && loser.packaging === "archive") {
    return "identical content; folder beats archive";
  }
  if (winner.packaging === "folder" && loser.packaging === "file") {
    return "identical content; folder beats loose file";
  }
  if (winner.packaging === "file" && loser.packaging === "archive") {
    return "identical content; unpacked file beats archive";
  }
  return "identical content — collapsed";
}

// A variant's signal: the strongest member signal, provided every member
// signal carries the same kind (mixed kinds on identical content means the
// names disagree — no usable signal, the rules below fall through).
function variantSignal(variant) {
  const sigs = variant.members.map((m) => m.versionSignal).filter(Boolean);
  const kinds = new Set(sigs.map((s) => s.kind));
  if (kinds.size !== 1) return null;
  return sigs.reduce((best, s) => (compareSignals(s, best) > 0 ? s : best));
}

// Diff stats between two bodies for the needs-decision side-by-side: distinct
// added / removed / changed line counts over the shared line-diff (ADR-0009
// "diff stats, content hints").
function diffStats(oldText, newText) {
  const entries = lineDiff((oldText ?? "").split(/\r?\n/), (newText ?? "").split(/\r?\n/));
  return { entries, counts: summarizeChanges(entries) };
}

// The first line variant B adds over variant A (or removes, when it only takes
// away) — the content hint that lets a human skim what actually diverged.
// Blank diff lines are skipped so the hint never renders as an empty string;
// null when the diff carries only blank-line changes (the hint line is omitted).
function firstChangeHint(entries) {
  const add = entries.find((e) => e.type === "add" && e.text.trim());
  if (add) return { verb: "adds", text: add.text };
  const del = entries.find((e) => e.type === "del" && e.text.trim());
  if (del) return { verb: "removes", text: del.text };
  return null;
}

/**
 * Group classified candidates into clusters and propose each cluster's
 * resolution (ADR-0009). Pure and deterministic — `--apply` (a later build)
 * reuses this to store exactly what the report proposed.
 *
 * Resolution rules, in order:
 * 1. Members collapse by content hash (ADR-0005 body hash) — identical
 *    content never competes, and the best packaging wins among identical
 *    copies (folder > loose file > archive).
 * 2. Divergent content (distinct hashes) is ordered by explicit version
 *    signal (`v3` < `v4`, semver compared numerically, date codes) — filename
 *    signals only, never mtime and never frontmatter stamps (`add` stamps
 *    every skill 1.0.0 by default; a stamp is no evidence of recency). A
 *    signal must be unambiguous: comparable kinds, a unique maximum, and a
 *    signaled variant beats unmarked ones. Unmarked losers then lose to the
 *    winner's explicit signal.
 * 3. Anything the rules cannot order — no signal, tied or mixed-kind signals —
 *    is `needs-decision`: the cluster carries a variant side-by-side (hash,
 *    line counts, diff stats vs the first variant, a first-change hint) for the
 *    agent layer to resolve in user-approved batches.
 *
 * @param {Array<object>} candidates Candidates from analyzeDirectory.
 * @returns {Array<{identity: string, members: Array<object>, resolved: boolean,
 *   winner: object|null, winnerNote: string|null, losers: Array<{member: object, reason: string}>,
 *   variants: Array<{hash: string, members: Array<object>, signal: object|null,
 *     lines: number, diff: {counts: object, hint: object|null}|null}>}>}
 */
export function resolveClusters(candidates) {
  const byIdentity = new Map();
  for (const c of candidates) {
    if (c.classification === JUNK) continue; // junk never clusters
    if (!byIdentity.has(c.identity)) byIdentity.set(c.identity, []);
    byIdentity.get(c.identity).push(c);
  }

  const clusters = [];
  for (const identity of [...byIdentity.keys()].sort()) {
    const members = byIdentity.get(identity).slice().sort(memberOrder);

    // Variants: distinct content (by hash), in deterministic member order.
    const variants = [];
    const byHash = new Map();
    for (const m of members) {
      if (!byHash.has(m.hash)) {
        const v = { hash: m.hash, members: [], signal: null };
        byHash.set(m.hash, v);
        variants.push(v);
      }
      byHash.get(m.hash).members.push(m);
    }
    for (const v of variants) {
      v.signal = variantSignal(v);
      v.lines = v.members[0].bodyText.split(/\r?\n/).length;
    }

    const cluster = { identity, members, resolved: true, winner: null, winnerNote: null, losers: [], variants };

    if (variants.length === 1) {
      // One content, n packagings: the collapse case — best form wins.
      cluster.winner = variants[0].members[0];
      cluster.losers = variants[0].members
        .slice(1)
        .map((m) => ({ member: m, reason: identicalLossReason(cluster.winner, m) }));
      clusters.push(cluster);
      continue;
    }

    // Divergent content: try to order the variants by version signal.
    const signaled = variants.filter((v) => v.signal);
    const kinds = new Set(signaled.map((v) => v.signal.kind));
    let top = null;
    let tie = false;
    if (signaled.length >= 1 && kinds.size === 1) {
      top = signaled[0];
      for (const v of signaled.slice(1)) {
        const c = compareSignals(v.signal, top.signal);
        if (c > 0) {
          top = v;
          tie = false;
        } else if (c === 0) {
          tie = true;
        }
      }
    }

    if (top && !tie) {
      cluster.winner = top.members[0];
      // Story 44 — the winner line carries its own plain-language reason, not
      // just the losers' reasons: what signal decided the cluster.
      cluster.winnerNote = `newest version signal (${top.signal.text})`;
      cluster.losers = [
        ...top.members
          .slice(1)
          .map((m) => ({ member: m, reason: identicalLossReason(cluster.winner, m) })),
        ...variants
          .filter((v) => v !== top)
          .flatMap((v) =>
            v.members.map((m) => ({
              member: m,
              reason: v.signal
                ? `older version signal (${v.signal.text} < ${top.signal.text})`
                : `no version signal (winner carries ${top.signal.text})`,
            })),
          ),
      ];
    } else {
      // No rule can order the variants — the side-by-side is the deliverable.
      cluster.resolved = false;
      const base = variants[0];
      for (const v of variants) {
        const d = v === base ? null : diffStats(base.members[0].bodyText, v.members[0].bodyText);
        v.diff = d ? { counts: d.counts, hint: firstChangeHint(d.entries) } : null;
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// --- safety column (ADR-0009) ---------------------------------------------------

// Compact per-candidate summary of the static safety findings (severity counts
// + pattern ids) — the report column, not a per-item walkthrough.
function safetySummary(findings) {
  if (!findings || findings.length === 0) return undefined;
  const uniq = (sev) =>
    [...new Set(findings.filter((f) => f.severity === sev).map((f) => f.id))].sort();
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    highIds: uniq("high"),
    mediumIds: uniq("medium"),
  };
}

// Read every file inside a folder package (bundled assets always travel with
// it, so they are scanned with it — the same file set `add` scans).
async function readFolderFiles(dir, prefix) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await readFolderFiles(full, prefix + e.name + "/")));
    else if (e.isFile()) files.push({ relPath: prefix + e.name, content: await readSkillText(full) });
  }
  return files;
}

// Every member text of an archive, concatenated by unzip — read-only, the same
// filtered member set classification inspected (`__MACOSX`/.DS_Store excluded).
// stderr is dropped: unzip prints "excluded filename not matched" cautions for
// harmless patterns, and the dry run must stay byte-stable on stdout anyway.
function readArchiveFiles(path) {
  try {
    const content = execFileSync(
      "unzip",
      ["-p", path, "-x", "__MACOSX/*", ".DS_Store", "*/.DS_Store"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return [{ relPath: path, content }];
  } catch {
    return [];
  }
}

/**
 * Run the static safety check across all non-junk candidates (read-only) and
 * attach the compact summary each report line renders as its column. Skill
 * packages scan SKILL.md plus bundled assets (folder) or archive members; a
 * bare skill file scans its full text (frontmatter included, the same bytes
 * `add` scans); prompt documents scan their raw text.
 *
 * @param {string} root The analyzed directory (absolute).
 * @param {Array<object>} candidates Candidates from analyzeDirectory.
 */
async function attachSafetySummaries(root, candidates) {
  for (const c of candidates) {
    if (c.classification === JUNK) continue;
    let files = [];
    if (c.packaging === "folder") files = await readFolderFiles(join(root, c.relPath), "");
    else if (c.packaging === "archive") files = readArchiveFiles(join(root, c.relPath));
    else if (c.classification === PROMPT) files = [{ relPath: c.relPath, content: c.content }];
    else files = [{ relPath: c.relPath, content: c.text ?? "" }];
    c.safety = safetySummary(scanSafety(files));
  }
}

// --- rendering ----------------------------------------------------------------

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The trailing safety column, e.g. `  safety: 1 high (rm-rf), 2 medium (curl, http-url)`.
function safetyTag(candidate) {
  const s = candidate.safety;
  if (!s) return "";
  const parts = [];
  if (s.high) parts.push(`${s.high} high (${s.highIds.join(", ")})`);
  if (s.medium) parts.push(`${s.medium} medium (${s.mediumIds.join(", ")})`);
  return parts.length ? `  safety: ${parts.join(", ")}` : "";
}

function classificationLabel(candidate) {
  return candidate.needsReview ? `${candidate.classification} (needs-review)` : candidate.classification;
}

// A prompt winner renders as the exact wrapped skill `--apply` would store
// (ADR-0010): the wrapped name plus a preview of the SKILL.md, indented under
// the winner line.
function wrapPreviewLines(candidate) {
  if (!candidate.wrapped) return [];
  // The preview shows the wrapped SKILL.md indented under the candidate; its
  // single trailing newline is trimmed (the report adds its own line break).
  const preview = candidate.wrapped.skillMd
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => (l === "" ? "" : "      " + l));
  return ["      wrap preview -> " + candidate.wrapped.name + "/SKILL.md", ...preview];
}

// Diff-stat fragment for a needs-decision variant vs variant 1.
function diffCountsPart(counts) {
  const parts = [];
  if (counts.added) parts.push(`+${counts.added} added`);
  if (counts.removed) parts.push(`-${counts.removed} removed`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  return parts.join(", ");
}

function renderResolvedCluster(cluster) {
  const width = Math.max(...cluster.members.map((m) => m.relPath.length)) + 2;
  const lines = [];
  const w = cluster.winner;
  // On a version-ordered cluster the winner states its deciding signal (and the
  // lineage it supersedes); on a collapsed cluster the packaging reason already
  // is the why.
  const note = cluster.winnerNote
    ? `; ${cluster.winnerNote} — supersedes ${plural(cluster.variants.length - 1, "older variant", "older variants")}`
    : "";
  lines.push(
    `    winner  ${w.relPath.padEnd(width)}  ${classificationLabel(w)}  ${w.reason}${note}${safetyTag(w)}`,
  );
  lines.push(...wrapPreviewLines(w));
  const losers = cluster.losers.slice().sort((a, b) => memberOrder(a.member, b.member));
  for (const { member, reason } of losers) {
    lines.push(
      `    loser   ${member.relPath.padEnd(width)}  hash ${shortHash(member.hash)}  ${reason}${safetyTag(member)}`,
    );
  }
  return lines;
}

function renderNeedsDecisionCluster(cluster) {
  const lines = [];
  cluster.variants.forEach((v, i) => {
    const n = i + 1;
    const stats = v.diff ? `  (${diffCountsPart(v.diff.counts)} vs variant 1)` : "";
    lines.push(
      `    variant ${n}  hash ${shortHash(v.hash)}  ${plural(v.lines, "line", "lines")}  ${plural(v.members.length, "member", "members")}${stats}`,
    );
    for (const m of v.members) {
      lines.push(`      ${m.relPath}${safetyTag(m)}`);
    }
    if (v.diff && v.diff.hint) {
      const text = v.diff.hint.text.trim().slice(0, 60) + (v.diff.hint.text.trim().length > 60 ? "…" : "");
      lines.push(`      hint: variant ${n} first ${v.diff.hint.verb} "${text}"`);
    }
  });
  return lines;
}

/**
 * Render the dry-run report (ADR-0009): clusters with the proposed resolution
 * (winner + reason, losers with hash and loss reason, or the needs-decision
 * side-by-side), the junk list, and a summary. Deterministic: same input,
 * same bytes.
 *
 * @param {string} root The analyzed directory (absolute).
 * @param {Array<object>} candidates The classified candidates.
 * @returns {string}
 */
export function renderReport(root, candidates) {
  const clusters = resolveClusters(candidates);
  const junk = candidates.filter((c) => c.classification === JUNK);
  const needsDecision = clusters.filter((c) => !c.resolved);

  const lines = [`Skill Ninja ingest — dry run analysis of ${root}`, "(analysis only: nothing is modified)", ""];

  lines.push(
    `Clusters (${clusters.length}${needsDecision.length ? `, ${needsDecision.length} needs-decision` : ""}):`,
  );
  if (clusters.length === 0) lines.push("  (none)");
  for (const cluster of clusters) {
    const header = `  ${cluster.identity} (${plural(cluster.members.length, "candidate", "candidates")})`;
    if (cluster.resolved) {
      lines.push(header);
      lines.push(...renderResolvedCluster(cluster));
    } else {
      lines.push(
        `${header} — NEEDS DECISION: same identity, different content, no version signal orders the variants`,
      );
      lines.push(...renderNeedsDecisionCluster(cluster));
    }
  }

  lines.push("", `Junk (${junk.length} — skipped, never deleted):`);
  if (junk.length === 0) lines.push("  (none)");
  for (const j of junk) lines.push(`  junk  ${j.relPath}  ${j.reason}`);

  const resolved = clusters.length - needsDecision.length;
  lines.push(
    "",
    `Summary: ${plural(clusters.length, "cluster", "clusters")} ` +
      `(${resolved} with a proposed winner` +
      `${needsDecision.length ? `, ${needsDecision.length} needs-decision` : ""}), ` +
      `${junk.length} junk — ${candidates.length} items.`,
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
  await attachSafetySummaries(opts.dir, items);
  process.stdout.write(renderReport(opts.dir, items));
  return 0;
}
