// `skill-ninja add` — ingest a new Skill safely (Issue #3 / T4).
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
import { extractBody } from "./hash.js";
import { renderDiff } from "./diff.js";
import { resolveSkillFromSource } from "./source.js";
import { linkSkill } from "./links.js";

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
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--to") opts.to = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--prompt") opts.prompt = args[++i];
    else if (a === "--name") opts.name = args[++i];
    else if (a === "--source") opts.sourceFlag = args[++i];
    else if (a === "--from") opts.fromFlag = args[++i];
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
    return { error: "no source given (a folder, file, repo/URL, or --prompt <text>)" };
  }
  return opts;
}

// --- source resolution -------------------------------------------------------

// Source resolution (folder / bare file / repo-URL -> SKILL.md content) lives in
// `source.js` and is shared with `diff`, so the two commands resolve sources
// identically. `gatherAssets` below is add-specific (only ingest copies assets).

// Collect bundled assets of a folder/repo skill: every file except SKILL.md,
// skipping .git and node_modules. Returns [{absPath, relPath}].
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
  return assets;
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

  const provSource = opts.sourceFlag || (sourceType === "repo" ? "external" : "received");
  const from = opts.fromFlag || (sourceType === "prompt" ? "prompt" : opts.source);

  return { name, content, assets, assetContents, sourceType, source: opts.source, from, provSource };
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
// identical to the extracted body and its hash round-trips.
function stampFrontmatter(stamps, body) {
  const p = stamps.provenance;
  const derivedFrom = p.derived_from === null || p.derived_from === undefined ? "null" : p.derived_from;
  const fm =
    "---\n" +
    `name: ${stamps.name}\n` +
    `version: ${stamps.version}\n` +
    `updated: ${stamps.updated}\n` +
    `hash: ${stamps.hash}\n` +
    "provenance:\n" +
    `  source: ${p.source}\n` +
    `  from: "${p.from}"\n` +
    `  imported: ${p.imported}\n` +
    `  derived_from: ${derivedFrom}\n` +
    "---\n";
  return fm + body;
}

// --- git commit + push (ADR-0007) -------------------------------------------
// The canonical store is a git repo with an optional private remote. `add`
// commits the new skill AND pushes it to the remote when one is configured;
// with no remote it commits locally and skips push silently.

function isGitRepo(dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The first configured remote name (typically "origin"), or null if none.
function firstRemote(store) {
  try {
    const out = execFileSync("git", ["-C", store, "remote"], { encoding: "utf8" });
    const name = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return name || null;
  } catch {
    return null;
  }
}

function tryCommit(store, name) {
  if (!isGitRepo(store)) return false;
  try {
    execFileSync("git", ["-C", store, "add", "--", name], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", store, "-c", "user.name=Skill Ninja", "-c", "user.email=skill-ninja@local", "commit", "-q", "-m", `add skill ${name}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false; // nothing to commit, or a hook rejected it — skip silently
  }
}

// Push the just-committed skill to the private remote. Sets upstream on the
// first push so a freshly-init'd store pushes without extra setup. Skipped
// silently (returns false) when no remote is configured or the push fails.
function tryPush(store) {
  const remote = firstRemote(store);
  if (!remote) return false;
  try {
    execFileSync("git", ["-C", store, "push", "-q", "-u", remote, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- command -----------------------------------------------------------------

/**
 * Run `skill-ninja add`. Returns the process exit code.
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
      err.write("No Skill Ninja configuration found. Run `skill-ninja init` first.\n");
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
    err.write("Try: skill-ninja add <folder|file|repo> [--to claude,zcode] [--name x] [--source received] [--from x]\n");
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

  // 2. Existing version? Show a diff + capture prior stamps for derived_from.
  const skillStoreDir = join(store, resolved.name);
  const storedFile = join(skillStoreDir, "SKILL.md");
  let prior = null;
  if (existsSync(storedFile)) {
    const storedText = await readFile(storedFile, "utf8");
    const storedStamps = parseFrontmatter(storedText);
    prior = {
      version: storedStamps.version ?? null,
      hash: storedStamps.hash ?? null,
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

  // 3. Place canonically (store copy is the source of truth) + copy assets.
  await mkdir(skillStoreDir, { recursive: true });
  const stamped = stampFrontmatter(
    {
      name: resolved.name,
      version,
      updated: today(),
      hash: incomingHash,
      provenance: {
        source: resolved.provSource,
        from: resolved.from,
        imported: today(),
        derived_from: derivedFrom,
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
  const committed = tryCommit(store, resolved.name);
  const pushed = committed ? tryPush(store) : false;

  // 6. Summary.
  out.write(`\nAdded skill '${resolved.name}' (version ${version}) to ${storedFile}.\n`);
  out.write(linked.length ? `Linked into: ${linked.join(", ")}.\n` : "Linked into: (no agent roots).\n");
  out.write(`Content hash: ${incomingHash}\n`);
  if (committed) out.write(`Committed to ${store}.\n`);
  if (pushed) out.write(`Pushed to the private remote.\n`);

  return 0;
}
