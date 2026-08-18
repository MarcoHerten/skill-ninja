// `ninja ingest <dir>` — the v1.1 bulk pipeline (ADR-0009). Walks a messy
// source directory, classifies every candidate as a skill package (any
// packaging), a prompt document, or junk, then resolves **clusters**:
// candidates sharing a normalized identity group together, one winner per
// cluster is proposed deterministically (byte-identical members collapse by
// content hash; an explicit version signal orders divergent content; the
// unpacked form beats the archive among identical copies), every loser is
// listed with its hash and the reason it lost, and divergent duplicates no
// rule can order become `needs-decision` with a side-by-side. The static
// safety check runs across all candidates as a report column. The dry run is
// strictly read-only; `--apply` executes the approved batch: it stores exactly
// the winners (wrapped where applicable) in the canonical store with ADR-0005
// stamps (`provenance.from` labels the batch, `derived_from` the superseded
// lineage), links nothing, leaves the source untouched, and lands the whole
// run as one git commit (+ push). Re-ingest compares against the store by
// identity + content hash: identical winners are skipped as already stored,
// changed ones become needs-decision with the stored copy in the side-by-side.
//
// CONTEXT.md: Candidate, Cluster, Ingest, Skill, Wrap. ADR-0009: cluster
// resolution rules, the inside/outside edge ("files inside a recognized
// package are bundled assets and always travel with it"), losers-not-stored,
// divergent-duplicates policy, re-ingest idempotency. ADR-0005: the content
// hash (the body hash) members collapse on and winners are stamped with.
// ADR-0010: the deterministic prompt wrap.

import { readdir, readFile, stat, open, mkdir, writeFile, copyFile, rm, mkdtemp } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { parseFrontmatter } from "./inventory.js";
import { bodyHash, extractBody, serializeStamps, splitFrontmatter } from "./hash.js";
import { lineDiff, summarizeChanges, shortHash } from "./diff.js";
import { renderChangelogFile, batchEntry } from "./changelog.js";
import { scanSafety } from "./safety.js";
import { loadConfig } from "./config.js";
import { ensureStore } from "./discover.js";
import { tryCommit, tryPush, firstRemote } from "./git.js";

const today = () => new Date().toISOString().slice(0, 10);

// Deterministic directory-entry order: sorted by name, everywhere the walk or
// the store scan lists entries (byte-stable output depends on it).
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

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
// live in filenames), and the content hash (ADR-0005 body hash). `skillFile`
// names where the skill file sits (the folder child / the archive member) so
// `--apply` can store exactly that text as SKILL.md and copy the sibling assets.
function skillItem({ relPath, stem, text, packagingReason, packaging, skillFile = null }) {
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
    skillFile,
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
    skillFile: member,
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
 * `derivedFrom` (the superseded lineage `--apply` records when the wrapped
 * winner superseded older prompt variants) defaults to null — the wrap preview
 * renders the pre-cluster form.
 *
 * @param {object} args
 * @param {string} args.content The prompt document's text.
 * @param {string} args.stem The filename stem (identity source).
 * @param {string} args.from The batch label (provenance.from, ADR-0009).
 * @param {string} args.imported The run date (YYYY-MM-DD).
 * @param {string|null} [args.derivedFrom] Lineage for `--apply` (default null).
 * @returns {{name: string, skillMd: string}}
 */
export function wrapPromptDocument({ content, stem, from, imported, derivedFrom = null }) {
  const name = normalizeIdentity(stem) || "unnamed";
  const fm = serializeStamps(
    {
      name,
      version: "1.0.0",
      updated: imported,
      hash: bodyHash(content),
      provenance: { source: "received", from, imported, derived_from: derivedFrom, relation: null },
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
    entries.sort(byName);

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
              skillFile: skillChild,
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

// The diff payload a needs-decision variant carries against its base variant:
// distinct change counts plus the first-change hint. One shape, built by both
// the cluster resolution and the store comparison.
function variantDiff(baseText, text) {
  const d = diffStats(baseText, text);
  return d ? { counts: d.counts, hint: firstChangeHint(d.entries) } : null;
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
        v.diff = v === base ? null : variantDiff(base.members[0].bodyText, v.members[0].bodyText);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// --- store comparison (re-ingest idempotency, ADR-0009) -------------------------

// The default needs-decision reason (rendered in the cluster header).
const NEEDS_REASON = "same identity, different content, no version signal orders the variants";
// The reason when the store forced the decision: replacing the user's stored,
// curated copy is never a rule's call — only the user's.
const NEEDS_REASON_STORE = "the stored version differs — replacing stored content is your decision";

/**
 * Index the canonical store by normalized identity: every skill directory with
 * a readable SKILL.md maps identity -> {dir, hash, body}. `add` stores skills
 * under their raw (unnormalized) names, so the key is the normalized frontmatter
 * name with the folder name as fallback — the same normalization identities use,
 * making the lookup robust to how the stored skill got there. A missing or
 * unreadable store yields an empty index (the comparison then no-ops).
 *
 * @param {string} store Path to the canonical store.
 * @returns {Promise<Map<string, {dir: string, hash: string, body: string}>>}
 */
export async function readStoreIndex(store) {
  const index = new Map();
  let entries;
  try {
    entries = await readdir(store, { withFileTypes: true });
  } catch {
    return index; // no store yet — nothing stored, nothing to compare
  }
  for (const e of entries.sort(byName)) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    let text;
    try {
      text = await readFile(join(store, e.name, "SKILL.md"), "utf8");
    } catch {
      continue; // not a skill directory (assets only, partial write, …)
    }
    const fm = parseFrontmatter(text);
    const identity = normalizeIdentity(
      (typeof fm.name === "string" && fm.name.trim()) || e.name,
    );
    if (!identity || index.has(identity)) continue;
    index.set(identity, { dir: join(store, e.name), hash: bodyHash(text), body: extractBody(text) });
  }
  return index;
}

// The stored copy as a side-by-side variant member: a pseudo-candidate whose
// relPath is its store directory (trailing slash, folder-style), so the
// needs-decision rendering shows where the competing content lives.
function storedMember(entry) {
  return {
    classification: SKILL,
    relPath: entry.dir + "/",
    packaging: "stored",
    bodyText: entry.body,
    hash: entry.hash,
    versionSignal: null,
  };
}

/**
 * Compare every cluster against the stored skills (ADR-0009 "re-ingest is
 * idempotent by identity"): a winner already in the store byte-for-byte marks
 * the cluster `alreadyStored` (nothing to do); a stored copy under the same
 * identity with *different* content forces the cluster to `needs-decision` —
 * the stored copy joins the side-by-side as its own variant — because
 * replacing stored content is the user's call even when a filename version
 * signal ordered the incoming candidates. Pure given the index; mutates and
 * returns the clusters.
 *
 * @param {Array<object>} clusters From resolveClusters.
 * @param {Map<string, {dir: string, hash: string, body: string}>} storeIndex
 * @returns {Array<object>}
 */
export function compareWithStore(clusters, storeIndex) {
  for (const cluster of clusters) {
    const entry = storeIndex.get(cluster.identity);
    if (!entry) continue;

    if (cluster.resolved && cluster.winner.hash === entry.hash) {
      cluster.alreadyStored = true;
      continue;
    }

    // The stored copy competes as a variant alongside the candidates (or joins
    // the variant it is byte-identical with, keeping the cluster's outcome).
    const member = storedMember(entry);
    const existing = cluster.variants.find((v) => v.hash === entry.hash);
    if (existing) {
      existing.members.push(member);
    } else {
      const base = cluster.variants[0];
      cluster.variants.push({
        hash: entry.hash,
        members: [member],
        signal: null,
        lines: entry.body.split(/\r?\n/).length,
        diff: variantDiff(base.members[0].bodyText, entry.body),
      });
    }

    // Differing stored content withdraws the proposal: no rule may pick the
    // incoming winner over the stored copy the user already curated.
    if (cluster.resolved) {
      cluster.resolved = false;
      cluster.winner = null;
      cluster.winnerNote = null;
      cluster.losers = [];
    }
    cluster.needsReason = NEEDS_REASON_STORE;
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
  for (const e of entries.sort(byName)) {
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
  // is the why. A winner the store already holds byte-for-byte says so — the
  // re-ingest no-op (ADR-0009).
  const note = cluster.winnerNote
    ? `; ${cluster.winnerNote} — supersedes ${plural(cluster.variants.length - 1, "older variant", "older variants")}`
    : "";
  const stored = cluster.alreadyStored ? "; already stored — identical content, nothing to do" : "";
  lines.push(
    `    winner  ${w.relPath.padEnd(width)}  ${classificationLabel(w)}  ${w.reason}${note}${stored}${safetyTag(w)}`,
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
 * side-by-side), the junk list, and a summary. Deterministic: the same
 * candidates AND the same store state render the same bytes (the store
 * comparison annotates already-stored winners and adds store-conflict
 * variants). Clusters may be passed in precomputed (as the command does, after
 * the store comparison re-marked them); by default they are resolved here.
 *
 * @param {string} root The analyzed directory (absolute).
 * @param {Array<object>} candidates The classified candidates.
 * @param {Array<object>} [clusters] Precomputed clusters (resolveClusters +
 *   compareWithStore output) — resolved fresh when omitted.
 * @returns {string}
 */
export function renderReport(root, candidates, clusters = resolveClusters(candidates)) {
  const junk = candidates.filter((c) => c.classification === JUNK);
  const needsDecision = clusters.filter((c) => !c.resolved);
  const alreadyStored = clusters.filter((c) => c.alreadyStored);

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
      lines.push(`${header} — NEEDS DECISION: ${cluster.needsReason ?? NEEDS_REASON}`);
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
      `${alreadyStored.length ? `, ${alreadyStored.length} already stored` : ""}` +
      `${needsDecision.length ? `, ${needsDecision.length} needs-decision` : ""}), ` +
      `${junk.length} junk — ${candidates.length} items.`,
    "Dry run: nothing was modified.",
  );
  return lines.join("\n") + "\n";
}

// --- apply (ADR-0009: store the approved batch) ---------------------------------

// The batch label every winner's provenance.from carries: the analyzed
// directory's basename (the label the wrap preview already stamps, so the
// previewed and stored bytes agree).
const batchLabel = (root) => basename(root);

// The superseded lineage a winner records in provenance.derived_from: the
// content hashes of its divergent losing variants (identical-copy losers share
// the winner's hash — nothing was superseded, the content lives on). Full
// hashes, deterministic variant order, comma-joined; null when nothing was
// superseded.
function winnerLineage(cluster) {
  const hashes = cluster.variants.filter((v) => v.hash !== cluster.winner.hash).map((v) => v.hash);
  return hashes.length ? hashes.join(", ") : null;
}

// The stamped SKILL.md `--apply` stores for a winner. Skill packages keep their
// own frontmatter (minus the stamped keys, keptFrontmatterLines): stamps add to
// the skill's own frontmatter without dropping it — SPEC.md's implementation
// decision, via the kept-lines mechanism ADR-0010 introduced (see also the
// 2026-08-17 update in ADR-0005); prompt winners store their wrapped form,
// re-wrapped only to fill the lineage the cluster step decided (the body, name,
// and all other stamps are byte-identical to the previewed wrap).
function storedSkillText(winner, cluster, { from, imported }, lineage) {
  if (winner.wrapped) {
    return wrapPromptDocument({
      content: winner.content,
      stem: winner.stem,
      from,
      imported,
      derivedFrom: lineage,
    }).skillMd;
  }
  return (
    serializeStamps(
      {
        name: cluster.identity,
        version: "1.0.0", // only new identities are ever stored (identical -> skip, changed -> needs-decision)
        updated: imported,
        hash: winner.hash,
        provenance: {
          source: "received",
          from,
          imported,
          derived_from: lineage,
          relation: null,
        },
      },
      keptFrontmatterLines(winner.text ?? ""),
    ) + extractBody(winner.text ?? "")
  );
}

// Collect a package's bundled assets (they always travel with it, ADR-0009):
// every file under the package dir except macOS noise, VCS/runtime dirs, and
// skill files — the stamped SKILL.md is written separately, and a package
// stores exactly one skill file. The package ROOT's CHANGELOG.md is excluded
// too (ADR-0012): the store owns that file and the changelog writer is its
// only writer; a nested changelog is an ordinary asset. The same file set the
// safety scan walks.
async function packageAssetFiles(pkgDir, atRoot = true) {
  const files = [];
  let entries;
  try {
    entries = await readdir(pkgDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries.sort(byName)) {
    if ([".git", "node_modules", "__MACOSX", ".DS_Store"].includes(e.name)) continue;
    if (atRoot && e.name === "CHANGELOG.md") continue;
    if (e.isFile()) {
      if (!isSkillFileName(e.name)) files.push({ absPath: join(pkgDir, e.name), relPath: e.name });
    } else if (e.isDirectory()) {
      for (const f of await packageAssetFiles(join(pkgDir, e.name), false)) {
        files.push({ absPath: f.absPath, relPath: e.name + "/" + f.relPath });
      }
    }
  }
  return files;
}

// Extract an archive into a fresh temp dir (never into the source) and return
// the dir; the caller removes it. Extraction failure yields whatever unzip did
// write — a missing package dir simply contributes no assets.
async function extractArchiveToTemp(archivePath) {
  const tmp = await mkdtemp(join(tmpdir(), "ninja-ingest-"));
  try {
    execFileSync("unzip", ["-q", "-o", archivePath, "-d", tmp], { stdio: "ignore" });
  } catch {
    // unreadable members — the walk below salvages what it can
  }
  return tmp;
}

// readFile that resolves to null for a missing path instead of throwing.
const readTextOrNull = async (p) => {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
};

// Copy one winner's bundled assets next to its stamped SKILL.md and return the
// author changelog the winner's package carries (ADR-0012 preamble; null when
// it has none — bare files and prompts never do). Folders copy straight out of
// the source; archives are unpacked to temp first, the package root being the
// skill member's directory.
async function copyWinnerAssets(root, winner, destDir) {
  if (winner.packaging === "folder") {
    await copyAssets(await packageAssetFiles(join(root, winner.relPath)), destDir);
    return await readTextOrNull(join(root, winner.relPath, "CHANGELOG.md"));
  }
  if (winner.packaging === "archive" && winner.skillFile) {
    const tmp = await extractArchiveToTemp(join(root, winner.relPath));
    try {
      const pkgDir = join(tmp, dirname(winner.skillFile));
      await copyAssets(await packageAssetFiles(pkgDir), destDir);
      return await readTextOrNull(join(pkgDir, "CHANGELOG.md"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return null;
}

async function copyAssets(files, destDir) {
  for (const f of files) {
    const dest = join(destDir, f.relPath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(f.absPath, dest);
  }
}

/**
 * Execute the approved batch (ADR-0009 `--apply`): store every resolved
 * cluster's winner into the canonical store (stamped, assets copied), skip
 * needs-decision clusters (never auto-decided) and already-stored ones
 * (idempotent re-ingest). Nothing is linked into any agent root; the source
 * directory is only ever read. Returns the applied-changes record the summary
 * renders.
 *
 * @param {string} root The analyzed directory.
 * @param {string} store The canonical store.
 * @param {Array<object>} clusters resolveClusters + compareWithStore output.
 * @param {Array<object>} candidates The classified candidates (junk counting).
 * @returns {Promise<{stored: Array<{identity: string, winner: object}>,
 *   skipped: Array<{identity: string, members: number, variants: number}>,
 *   alreadyStored: Array<{identity: string, hash: string}>,
 *   losers: Array<{member: object, reason: string}>, junkCount: number}>}
 */
async function applyClusters(root, store, clusters, candidates) {
  const result = {
    stored: [],
    skipped: [],
    alreadyStored: [],
    losers: [],
    junkCount: candidates.filter((c) => c.classification === JUNK).length,
  };
  const ctx = { from: batchLabel(root), imported: today() };

  for (const cluster of clusters) {
    if (!cluster.resolved) {
      result.skipped.push({
        identity: cluster.identity,
        members: cluster.members.length,
        variants: cluster.variants.length,
      });
      continue;
    }
    if (cluster.alreadyStored) {
      result.alreadyStored.push({ identity: cluster.identity, hash: cluster.winner.hash });
      continue;
    }
    const destDir = join(store, cluster.identity);
    await mkdir(destDir, { recursive: true });
    // The lineage is decided once and shared by the SKILL.md stamps and the
    // changelog entry — the two cannot disagree.
    const lineage = winnerLineage(cluster);
    await writeFile(join(destDir, "SKILL.md"), storedSkillText(cluster.winner, cluster, ctx, lineage), "utf8");
    const authorChangelog = await copyWinnerAssets(root, cluster.winner, destDir);
    await writeFile(
      join(destDir, "CHANGELOG.md"),
      renderChangelogFile({
        name: cluster.identity,
        authorContent: authorChangelog ?? "",
        entries: [
          batchEntry({
            version: "1.0.0", // only new identities are ever stored
            date: ctx.imported,
            from: ctx.from,
            supersededHashes: lineage ? lineage.split(", ") : [],
          }),
        ],
      }),
      "utf8",
    );
    result.stored.push({ identity: cluster.identity, winner: cluster.winner });
    result.losers.push(...cluster.losers);
  }
  return result;
}

function renderAppliedSummary(root, store, result, gitInfo) {
  const width =
    Math.max(
      8,
      ...result.stored.map((s) => s.identity.length),
      ...result.skipped.map((s) => s.identity.length),
      ...result.alreadyStored.map((s) => s.identity.length),
      ...result.losers.map((l) => l.member.relPath.length),
    ) + 2;
  const lines = [
    `Skill Ninja ingest — applying ${root}`,
    `(batch '${batchLabel(root)}': storing winners into ${store}; the source directory is never modified)`,
    "",
  ];

  if (result.stored.length) {
    lines.push(`Stored ${plural(result.stored.length, "skill", "skills")}:`);
    for (const s of result.stored) {
      lines.push(
        `  stored   ${s.identity.padEnd(width)}  hash ${shortHash(s.winner.hash)}  ${classificationLabel(s.winner)}${safetyTag(s.winner)}`,
      );
    }
  } else {
    lines.push("Nothing to store.");
  }

  if (result.alreadyStored.length) {
    lines.push("", `Already stored ${plural(result.alreadyStored.length, "skill", "skills")} (identical content — nothing to do):`);
    for (const s of result.alreadyStored) {
      lines.push(`  already  ${s.identity.padEnd(width)}  hash ${shortHash(s.hash)}`);
    }
  }

  if (result.skipped.length) {
    lines.push("", `Skipped ${plural(result.skipped.length, "conflict", "conflicts")} (needs-decision — never auto-decided):`);
    for (const s of result.skipped) {
      lines.push(
        `  skipped  ${s.identity.padEnd(width)}  ${plural(s.members, "candidate", "candidates")}, ${plural(s.variants, "variant", "variants")} — decide via the dry-run report, then re-run`,
      );
    }
  }

  if (result.losers.length) {
    lines.push("", `Discarded ${plural(result.losers.length, "loser", "losers")} (reported, never stored — the source keeps them):`);
    for (const { member, reason } of result.losers.slice().sort((a, b) => memberOrder(a.member, b.member))) {
      lines.push(`  loser    ${member.relPath.padEnd(width)}  hash ${shortHash(member.hash)}  ${reason}`);
    }
  }

  lines.push("", `Junk: ${result.junkCount} (skipped, never deleted — see the dry-run report).`);

  if (result.stored.length === 0) {
    lines.push("", "No commit — nothing new was stored.");
    return lines.join("\n") + "\n";
  }
  if (gitInfo.committed) lines.push("", `Committed to ${store} (${gitInfo.message}).`);
  else
    lines.push(
      "",
      "Not committed (git unavailable, nothing to commit, or a hook rejected it — the skills are stored, versioning skipped).",
    );
  if (gitInfo.pushed) lines.push("Pushed to the private remote.");
  else if (gitInfo.pushFailed) lines.push("Push failed — the commit stays local (retry with `git push`).");
  return lines.join("\n") + "\n";
}

// --- command ------------------------------------------------------------------

function parseIngestArgs(args) {
  const opts = { dir: undefined, apply: false };
  for (const a of args) {
    if (a === "--apply") opts.apply = true;
    else if (a.startsWith("--")) return { error: `unknown option: ${a}` };
    else if (opts.dir === undefined) opts.dir = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (opts.dir === undefined) return { error: "no directory given" };
  return opts;
}

// Clusters for a run: resolved, then compared against the canonical store when
// one is usable, so both the report and `--apply` see the same already-stored /
// store-conflict states. The dry run needs no config (a ticket-01 pin) — no
// store, no comparison, silently.
async function comparedClusters(items, store) {
  let storeDir = store;
  if (storeDir === null) {
    try {
      storeDir = (await loadConfig(homedir())).store ?? null;
    } catch {
      storeDir = null; // no config — analysis only, nothing to compare against
    }
  }
  const clusters = resolveClusters(items);
  if (!storeDir) return clusters;
  return compareWithStore(clusters, await readStoreIndex(storeDir));
}

/**
 * Run `ninja ingest <dir>` — the dry-run analysis, or with `--apply` the
 * approved batch's execution (store winners, one commit + push). Returns the
 * process exit code.
 * @param {string[]} args
 */
export async function ingestCommand(args) {
  const opts = parseIngestArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nTry: ninja ingest <dir> [--apply]\n`);
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

  // --apply writes the store, so it needs the configured landscape (the same
  // gates `add` uses); the dry run stays config-free.
  let store = null;
  if (opts.apply) {
    let config;
    try {
      config = await loadConfig(homedir());
    } catch (e) {
      if (e && e.code === "ENOENT") {
        process.stderr.write("No Skill Ninja configuration found. Run `ninja init` first.\n");
        return 2;
      }
      throw e;
    }
    store = config.store ?? null;
    if (!store) {
      process.stderr.write("No canonical store configured (set `store` in ~/.skill-ninja/config.json).\n");
      return 2;
    }
    await ensureStore(store);
  }

  const items = await analyzeDirectory(opts.dir);
  await attachSafetySummaries(opts.dir, items);
  const clusters = await comparedClusters(items, store);

  if (!opts.apply) {
    process.stdout.write(renderReport(opts.dir, items, clusters));
    return 0;
  }

  const result = await applyClusters(opts.dir, store, clusters, items);

  // One commit for the whole run (the batch approval unit, ADR-0009), pushed
  // to the private remote when one is configured — commit-only otherwise, and
  // no commit at all when nothing new was stored (the idempotent re-ingest).
  let committed = false;
  let pushed = false;
  let pushFailed = false;
  let message = "";
  if (result.stored.length) {
    const conflicts = result.skipped.length === 1 ? "1 conflict" : `${result.skipped.length} conflicts`;
    message = `ingest ${batchLabel(opts.dir)}: ${result.stored.length} stored, ${conflicts} skipped, ${result.junkCount} junk`;
    committed = tryCommit(store, result.stored.map((s) => s.identity), message);
    // A configured remote that fails to take the push is reported, not hidden
    // (no remote at all stays silent, like `add`).
    const remote = committed ? firstRemote(store) : null;
    pushed = remote ? tryPush(store) : false;
    pushFailed = Boolean(remote) && !pushed;
  }
  process.stdout.write(
    renderAppliedSummary(opts.dir, store, result, { message, committed, pushed, pushFailed }),
  );
  return 0;
}
