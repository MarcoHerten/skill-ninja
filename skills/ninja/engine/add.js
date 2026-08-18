// `ninja add` — ingest a new Skill safely (Issue #3 / T4).
//
// Non-interactive engine command: ingest a source (folder, bare file/prompt, or
// repo/URL), run the lightweight safety check, show a diff against any existing
// version, place the Skill in the **canonical store**, link it into the chosen
// agent roots (resolving tool asymmetry), stamp version / provenance / content
// hash (ADR-0005), and commit + push to the private remote (ADR-0007). The skill layer
// (SKILL.md) frames the human approval of safety findings; the engine never
// blocks on a finding — it only reports.
//
// CONTEXT.md: Skill, Provenance, Agent root, Tool asymmetry, canonical store.
// ADR-0005: the stamping & content-hash contract T5 (diff) depends on.

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";

import { loadConfig } from "./config.js";
import { agentRoot } from "./agents.js";
import { parseFrontmatter } from "./inventory.js";
import { scanSafety, renderSafety } from "./safety.js";
import { extractBody, serializeStamps } from "./hash.js";
import { renderDiff } from "./diff.js";
import { renderChangelogFile, firstEntry } from "./changelog.js";
import { resolveSkillFromSource } from "./source.js";
import { linkSkill } from "./links.js";
import { findComparableSkills, renderComparables } from "./compare.js";
import { tryCommit, tryPush } from "./git.js";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

// --- argument parsing --------------------------------------------------------

function parseAddArgs(args) {
  const opts = {
    source: undefined,
    to: null,
    prompt: undefined,
    name: null,
    sourceFlag: null,
    fromFlag: null,
    relationFlag: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--to") opts.to = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--prompt") opts.prompt = args[++i];
    else if (a === "--name") opts.name = args[++i];
    else if (a === "--source") opts.sourceFlag = args[++i];
    else if (a === "--from") opts.fromFlag = args[++i];
    else if (a === "--relation") opts.relationFlag = args[++i];
    else if (a.startsWith("--")) return { error: `unknown option: ${a}` };
    else if (opts.source === undefined && opts.prompt === undefined) opts.source = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (
    opts.sourceFlag &&
    !["authored", "received", "external"].includes(opts.sourceFlag)
  ) {
    return { error: `--source must be authored, received, or external (got '${opts.sourceFlag}')` };
  }
  if (opts.prompt === undefined && opts.source === undefined) {
    return { error: "no source given (a folder, file, zip, repo/URL, or --prompt <text>)" };
  }
  return opts;
}

// --- source resolution -------------------------------------------------------

// Source resolution (folder / bare file / repo-URL -> SKILL.md content) lives in
// `source.js` and is shared with `diff`, so the two commands resolve sources
// identically. `gatherAssets` below is add-specific (only ingest copies assets).

// Collect bundled assets of a folder/repo skill: every file except SKILL.md,
// skipping .git and node_modules. Returns [{absPath, relPath}]. The package
// root's CHANGELOG.md is excluded too — the store owns that file (ADR-0012),
// and the changelog writer is its only writer; a nested changelog (e.g.
// references/CHANGELOG.md) is an ordinary asset and travels.
async function gatherAssets(dir) {
  const assets = [];
  async function walk(sub) {
    let entries;
    try {
      entries = await readdir(sub, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "SKILL.md" || e.name === ".git" || e.name === "node_modules") continue;
      const full = join(sub, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) assets.push({ absPath: full, relPath: relative(dir, full) });
    }
  }
  await walk(dir);
  return assets.filter((a) => a.relPath !== "CHANGELOG.md");
}

/**
 * Resolve a source argument into the skill content, name, assets, and the
 * provenance defaults. Throws on an unusable source.
 *
 * @returns {Promise<{name, content, assets, assetContents, sourceType, source, from, provSource}>}
 */
async function resolveSource(opts) {
  let sourceType;
  let dir = null;
  let content;

  if (opts.prompt !== undefined) {
    sourceType = "prompt";
    content = opts.prompt;
  } else {
    // Shared resolution: folder / bare file / repo-URL -> SKILL.md content +
    // the working dir (for bundled assets). Reused by `diff`.
    ({ content, dir, sourceType } = await resolveSkillFromSource(opts.source));
  }

  // Name: --name wins, else incoming frontmatter `name`, else the source dir
  // basename (folder/repo). Bare file/prompt sources require --name (or fm name).
  const fmName = parseFrontmatter(content).name;
  const name = opts.name || fmName || (dir ? basename(dir) : null);
  if (!name) throw new Error("could not determine skill name (pass --name)");
  if (name.includes("/")) throw new Error(`invalid skill name: '${name}'`);

  let assets = [];
  if (dir) assets = await gatherAssets(dir);
  const assetContents = [];
  for (const a of assets) {
    let c = "";
    try {
      c = await readFile(a.absPath, "utf8");
    } catch {
      c = "";
    }
    assetContents.push({ relPath: a.relPath, content: c });
  }

  // The incoming author changelog (ADR-0012), when the source carries one —
  // preserved verbatim as the generated file's preamble on first ingest.
  let authorChangelog = null;
  if (dir) {
    try {
      authorChangelog = await readFile(join(dir, "CHANGELOG.md"), "utf8");
    } catch {
      authorChangelog = null;
    }
  }

  const provSource = opts.sourceFlag || (sourceType === "repo" ? "external" : "received");
  const from = opts.fromFlag || (sourceType === "prompt" ? "prompt" : opts.source);

  return { name, content, assets, assetContents, authorChangelog, sourceType, source: opts.source, from, provSource };
}

// --- stamping ----------------------------------------------------------------

// Bump/assign the version per ADR-0005: new -> 1.0.0; re-add with changed
// content -> PATCH bump; identical re-add -> unchanged; unparseable prior -> 1.0.0.
function nextVersion(existingVersion, contentChanged) {
  if (!existingVersion) return "1.0.0";
  if (!contentChanged) return existingVersion;
  const m = String(existingVersion).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return "1.0.0";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// Serialize the stamp block (ADR-0005 keys, deterministic order) + the body
// verbatim. No blank line after the closing fence, so the stored body is byte-
// identical to the extracted body and its hash round-trips. Stamps ADD to the
// skill's own frontmatter, they never silently drop it: the incoming
// `description` (the agent-activation text) is preserved (skill-intake rule),
// as is `relation` (free text, quoted like `from`). The serialization itself
// lives in hash.js (shared with ingest's prompt wrapping, ADR-0010).
function stampFrontmatter(stamps, body) {
  return serializeStamps(stamps) + body;
}

// --- git commit + push (ADR-0007) -------------------------------------------
// The canonical store is a git repo with an optional private remote. `add`
// commits the new skill AND pushes it to the remote when one is configured;
// with no remote it commits locally and skips push silently. The git calls
// themselves live in git.js, shared with `ingest --apply`'s batch commit.

// --- command -----------------------------------------------------------------

/**
 * Run `ninja add`. Returns the process exit code.
 * @param {string[]} args
 */
export async function addCommand(args) {
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

  const opts = parseAddArgs(args);
  if (opts.error) {
    err.write(`${opts.error}\n`);
    err.write("Try: ninja add <folder|file|zip|repo> [--to claude,zcode] [--name x] [--source received] [--from x] [--relation \"...\"]\n");
    return 2;
  }

  let resolved;
  try {
    resolved = await resolveSource(opts);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 2;
  }

  // 1. Safety check (reports; never blocks).
  const files = [{ relPath: "SKILL.md", content: resolved.content }, ...resolved.assetContents];
  const findings = scanSafety(files);
  out.write(renderSafety(findings));

  // 2. Existing version? Show a diff + capture prior stamps for derived_from
  //    and relation carry-forward.
  const skillStoreDir = join(store, resolved.name);
  const storedFile = join(skillStoreDir, "SKILL.md");
  let prior = null;
  if (existsSync(storedFile)) {
    const storedText = await readFile(storedFile, "utf8");
    const storedStamps = parseFrontmatter(storedText);
    prior = {
      version: storedStamps.version ?? null,
      hash: storedStamps.hash ?? null,
      description: typeof storedStamps.description === "string" ? storedStamps.description : null,
      relation: storedStamps.provenance?.relation ?? null,
      body: extractBody(storedText),
    };
  }

  const incomingBody = extractBody(resolved.content);
  const incomingHash = sha256(incomingBody);
  const contentChanged = prior ? prior.hash !== incomingHash : false;
  const version = nextVersion(prior ? prior.version : null, prior ? contentChanged : false);
  const derivedFrom = prior ? prior.hash : null;

  if (prior) {
    out.write(
      `\nExisting skill '${resolved.name}' found in the store (version ${prior.version ?? "unknown"}). ` +
        "Diff vs stored version:\n",
    );
    out.write(renderDiff(prior.body, incomingBody) + "\n");
  }

  // 2.5 Comparable skills (ported from skill-intake): same family under another
  //     name — shared name stems, overlapping descriptions, or identical
  //     content. Reported, never blocking; the replace/parallel/merge/reject
  //     decision is the user's, guided by the skill layer.
  const incomingFm = parseFrontmatter(resolved.content);
  const incomingDescription = typeof incomingFm.description === "string" ? incomingFm.description : null;
  const comparables = await findComparableSkills(store, resolved.name, incomingDescription, resolved.content);
  out.write("\n" + renderComparables(comparables));

  // 3. Place canonically (store copy is the source of truth) + copy assets.
  // Stamps add to the skill's own frontmatter without dropping it: description
  // and relation carry forward from the prior stored version when the incoming
  // version doesn't supply them (--relation wins when given).
  const relation = opts.relationFlag ?? (prior ? prior.relation : null);
  await mkdir(skillStoreDir, { recursive: true });
  const stamped = stampFrontmatter(
    {
      name: resolved.name,
      description: incomingFm.description ?? (prior ? prior.description : null),
      version,
      updated: today(),
      hash: incomingHash,
      provenance: {
        source: resolved.provSource,
        from: resolved.from,
        imported: today(),
        derived_from: derivedFrom,
        relation,
      },
    },
    incomingBody,
  );
  await writeFile(storedFile, stamped, "utf8");
  for (const a of resolved.assets) {
    const dest = join(skillStoreDir, a.relPath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(a.absPath, dest);
  }

  // 3.5 CHANGELOG.md (ADR-0012): the human-readable projection of the stamps,
  //     written by the shared changelog writer only — never a plain asset copy
  //     (gatherAssets excludes it). New skill -> header (+ the preserved
  //     author preamble) + first entry; re-adds are Issue #8's update path.
  if (!prior) {
    await writeFile(
      join(skillStoreDir, "CHANGELOG.md"),
      renderChangelogFile({
        name: resolved.name,
        authorContent: resolved.authorChangelog ?? "",
        entries: [
          firstEntry({
            version,
            date: today(),
            source: resolved.provSource,
            from: resolved.from,
            relation,
          }),
        ],
      }),
      "utf8",
    );
  }

  // 4. Link into the chosen agent roots (resolves tool asymmetry: one canonical
  //    file, symlinked everywhere). Default = all configured agents. Uses the
  //    shared linking primitive `doctor` also reuses for dedup consolidation.
  const to = !opts.to || opts.to.length === 0 ? config.agents : opts.to;
  const linked = [];
  for (const key of to) {
    const root = agentRoot(key, home);
    if (!root) {
      out.write(`(skipping unknown agent '${key}')\n`);
      continue;
    }
    const link = join(root, resolved.name);
    await linkSkill(link, skillStoreDir); // mkdir parent + refresh any prior link/dir
    linked.push(`${link} (${key})`);
  }

  // 5. Commit + push (ADR-0007): commit the skill, then push to the private
  //    remote if one is configured (skipped silently otherwise).
  const committed = tryCommit(store, [resolved.name], `add skill ${resolved.name}`);
  const pushed = committed ? tryPush(store) : false;

  // 6. Summary.
  out.write(`\nAdded skill '${resolved.name}' (version ${version}) to ${storedFile}.\n`);
  out.write(linked.length ? `Linked into: ${linked.join(", ")}.\n` : "Linked into: (no agent roots).\n");
  out.write(`Content hash: ${incomingHash}\n`);
  if (committed) out.write(`Committed to ${store}.\n`);
  if (pushed) out.write(`Pushed to the private remote.\n`);

  return 0;
}
