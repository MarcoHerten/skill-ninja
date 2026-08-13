// Black-box tests for `skill-ninja add` (Issue #3 / T4) — safe ingest with
// stamping, content hash, store placement + agent-root linking, safety check,
// existing-version diff, repo source, and git commit. Tests plant a source in a
// sandboxed fake $HOME, run the CLI, and assert on stdout + filesystem only.
// Expected hashes/versions come from INDEPENDENT sources (a known literal or a
// sha256 computed in the test from known content), never from engine code.
// (ADR-0001 seam; ADR-0005 stamping contract.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  storePath,
  makeStoreGitRepo,
  makeLocalSkillRepo,
  readStoredSkill,
  parseStamps,
} from "./helpers/harness.js";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

// Slice A — a folder source is placed canonically in the store, SKILL.md and any
// bundled assets copied. (Placement.)
test("add places a folder skill in the canonical store with its assets", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/my-skill", {
      body: "# My skill\n",
    });
    // A bundled asset sibling to SKILL.md must be copied too.
    await mkdir(join(planted.dir, "assets"), { recursive: true });
    await writeFile(join(planted.dir, "assets", "helper.txt"), "help\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    const storedFile = join(storePath(sb.home), "my-skill", "SKILL.md");
    const storedAsset = join(storePath(sb.home), "my-skill", "assets", "helper.txt");
    assert.ok(existsSync(storedFile), `expected stored SKILL.md at ${storedFile}`);
    const storedText = await readFile(storedFile, "utf8");
    // The stored copy carries stamped frontmatter; the incoming body is preserved.
    assert.ok(storedText.startsWith("---\n"), `expected frontmatter, got:\n${storedText}`);
    assert.ok(storedText.includes("# My skill\n"), `expected the body preserved, got:\n${storedText}`);
    assert.ok(existsSync(storedAsset), `expected bundled asset copied to ${storedAsset}`);
    assert.equal(await readFile(storedAsset, "utf8"), "help\n");
    assert.match(stdout, /my-skill/, `expected the skill name in stdout, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice B — the stored SKILL.md carries stamped frontmatter: version, updated,
// provenance{source,from,imported,derived_from}, and a SHA-256 content hash that
// matches an independently-computed hash of the documented bytes. (Stamping — the
// key T5-dependency slice.)
test("add stamps version, updated, provenance, and a content hash", async () => {
  const sb = await createSandbox();
  try {
    const body = "# Stamp me\n";
    const planted = await plantSkill(sb.home, "incoming/stamper", { body });

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const text = await readStoredSkill(sb.home, "stamper");
    const stamps = parseStamps(text);

    assert.equal(stamps.version, "1.0.0", `version, got:\n${text}`);
    assert.equal(stamps.updated, today(), `updated date, got:\n${text}`);
    assert.equal(stamps.name, "stamper");

    // The hash is sha256 of the body (no frontmatter on the incoming skill, so
    // the body is the whole content) — computed independently here.
    const expectedHash = sha256(body);
    assert.equal(stamps.hash, expectedHash, `content hash, got:\n${text}`);
    assert.match(String(stamps.hash), /^[0-9a-f]{64}$/, "hash is 64 hex chars");

    assert.deepEqual(stamps.provenance, {
      source: "received", // folder default
      from: planted.dir, // the source arg as given
      imported: today(),
      derived_from: null, // new skill
    }, `provenance, got:\n${text}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — `--to claude,zcode` links the store copy into both agent roots; the
// links resolve tool asymmetry (one canonical file, available everywhere).
test("add --to links the store copy into the chosen agent roots via symlinks", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/linked", { body: "# Linked\n" });

    const { exitCode } = await runCli(sb.home, ["add", planted.dir, "--to", "claude,zcode"]);
    assert.equal(exitCode, 0);

    const storeSkillDir = join(storePath(sb.home), "linked");
    for (const root of [".claude/skills", ".zcode/skills"]) {
      const link = join(sb.home, root, "linked");
      const st = await lstat(link);
      assert.ok(st.isSymbolicLink(), `expected a symlink at ${link}`);
      const target = await readlink(link);
      assert.equal(target, storeSkillDir, `symlink target for ${link}`);
      // Following the link reads the stored SKILL.md (its body is reachable).
      const through = await readFile(join(link, "SKILL.md"), "utf8");
      assert.ok(through.includes("# Linked\n"), `body reachable through ${link}, got:\n${through}`);
    }
  } finally {
    await sb.cleanup();
  }
});

// Slice D — a skill with a risky pattern is reported in plain language with a
// snippet BEFORE it is placed; the engine reports but does not block.
test("add runs a safety check and reports risky patterns before placing", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/risky", {
      body: "Clean up with `rm -rf /tmp/junk`.\nThen call curl http://example.com.\n",
    });

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);

    assert.equal(exitCode, 0, `expected exit 0 (report, not block), stderr:\n${stdout}`);
    // The safety section names the patterns and shows a snippet, in plain language.
    assert.match(stdout, /safety/i, `expected a safety section, got:\n${stdout}`);
    assert.ok(stdout.includes("rm -rf"), `expected the rm -rf snippet, got:\n${stdout}`);
    assert.ok(stdout.includes("curl"), `expected the curl snippet, got:\n${stdout}`);
    assert.match(stdout, /\d+ high/i, `expected a high-severity count, got:\n${stdout}`);
    // Safety output comes before the placement summary.
    const safetyAt = stdout.indexOf("Safety check");
    const placedAt = stdout.indexOf("Added skill");
    assert.ok(safetyAt !== -1 && placedAt !== -1 && safetyAt < placedAt, `expected safety before placement, got:\n${stdout}`);
    // The skill is still placed (engine reports, does not block).
    assert.ok(existsSync(join(storePath(sb.home), "risky", "SKILL.md")), "risky skill still placed");
  } finally {
    await sb.cleanup();
  }
});

// Slice E — re-adding a skill whose name already exists shows a diff, bumps the
// version, and records derived_from = the prior content hash.
test("add shows a diff and stamps derived_from when re-adding an existing skill", async () => {
  const sb = await createSandbox();
  try {
    const v1body = "# v1 body\n";
    const v2body = "# v2 body\nsecond line\n";
    const v1 = await plantSkill(sb.home, "incoming-1/foo", { body: v1body });
    const v2 = await plantSkill(sb.home, "incoming-2/foo", { body: v2body });

    // First add — places v1.
    await runCli(sb.home, ["add", v1.dir]);
    // Second add — different content, same name.
    const { stdout, exitCode } = await runCli(sb.home, ["add", v2.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // A diff against the stored version is shown.
    assert.match(stdout, /diff/i, `expected a diff section, got:\n${stdout}`);
    assert.ok(stdout.includes("- # v1 body"), `expected removed line in diff, got:\n${stdout}`);
    assert.ok(stdout.includes("+ # v2 body"), `expected added line in diff, got:\n${stdout}`);

    // Version bumped to 1.0.1; derived_from carries the prior content hash.
    const stamps = parseStamps(await readStoredSkill(sb.home, "foo"));
    assert.equal(stamps.version, "1.0.1", `expected patch bump, got:\n${stamps.version}`);
    assert.equal(stamps.provenance.derived_from, sha256(v1body), `derived_from = prior hash`);
  } finally {
    await sb.cleanup();
  }
});

// Slice F — a repo/URL source is cloned via git then ingested. Tested OFFLINE by
// pointing at a local git repo whose path ends in `.git` (no network).
test("add accepts a repo source by cloning it (offline via a local git repo)", async () => {
  const sb = await createSandbox();
  try {
    const repoBody = "# From repo\n";
    const repoPath = makeLocalSkillRepo(join(sb.home, "incoming", "demo.git"), {
      name: "repo-skill",
      body: repoBody,
    });

    const { stdout, exitCode } = await runCli(sb.home, ["add", repoPath]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // Placed + stamped. The repo SKILL.md had frontmatter (name: repo-skill) plus
    // a body, so the hash is sha256 of the extracted body (the blank-line-prefixed
    // body that follows the closing fence).
    const text = await readStoredSkill(sb.home, "repo-skill");
    const stamps = parseStamps(text);
    assert.equal(stamps.name, "repo-skill");
    assert.equal(stamps.version, "1.0.0");
    assert.equal(stamps.hash, sha256("\n" + repoBody), `hash of extracted body, got:\n${text}`);
    assert.equal(stamps.provenance.source, "external", `repo default source`);
    assert.equal(stamps.provenance.from, repoPath, `from = the repo source arg`);
    assert.match(stdout, /repo-skill/);
  } finally {
    await sb.cleanup();
  }
});

// Slice G — when the canonical store is a git repo, the addition is committed
// locally (no push). Verified via `git -C <store> log`.
test("add commits the skill when the canonical store is a git repo", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    const planted = await plantSkill(sb.home, "incoming/gitskill", { body: "# Git skill\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // The skill is placed and a local commit referencing it exists.
    assert.ok(existsSync(join(storePath(sb.home), "gitskill", "SKILL.md")), "placed");
    const log = execFileSync("git", ["-C", storePath(sb.home), "log", "--format=%s"], {
      encoding: "utf8",
    });
    assert.match(log, /gitskill/, `expected a commit mentioning the skill, got:\n${log}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice H — a bare file source (a single SKILL.md path) is accepted.
test("add accepts a bare SKILL.md file as the source", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/loose", {
      frontmatter: { name: "loose-skill" },
      body: "# Loose file skill\n",
    });

    const { exitCode } = await runCli(sb.home, ["add", planted.file, "--name", "loose-skill"]);
    assert.equal(exitCode, 0);
    const stamps = parseStamps(await readStoredSkill(sb.home, "loose-skill"));
    assert.equal(stamps.name, "loose-skill");
    assert.equal(stamps.version, "1.0.0");
  } finally {
    await sb.cleanup();
  }
});

// Slice I — a bare prompt source (raw content via --prompt) is accepted.
test("add accepts a bare prompt as the source via --prompt", async () => {
  const sb = await createSandbox();
  try {
    const { exitCode } = await runCli(sb.home, [
      "add",
      "--prompt",
      "# Prompted skill\n",
      "--name",
      "prompted",
    ]);
    assert.equal(exitCode, 0);
    const stamps = parseStamps(await readStoredSkill(sb.home, "prompted"));
    assert.equal(stamps.name, "prompted");
    assert.equal(stamps.version, "1.0.0");
    assert.equal(stamps.hash, sha256("# Prompted skill\n"));
  } finally {
    await sb.cleanup();
  }
});
