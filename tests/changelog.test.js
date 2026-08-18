// Black-box tests for the per-skill CHANGELOG.md (Issues #7 / #8 / #9,
// ADR-0012): `add` creates the file on first ingest (preserving the incoming
// author changelog), a changed re-add appends the version entry (bootstrapping
// pre-feature skills), identical re-adds leave it byte-identical, and
// `ingest --apply` writes batch entries for stored winners (idempotently,
// never for needs-decision). Tests run the CLI against a sandboxed fake $HOME
// and assert on stdout + the resulting filesystem only (ADR-0001 seam); hashes
// and counts are computed independently from known content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  storePath,
  makeStoreGitRepo,
} from "./helpers/harness.js";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const shortHash = (h) => h.slice(0, 8) + "…";

const readStoredChangelog = (home, name) =>
  readFile(join(storePath(home), name, "CHANGELOG.md"), "utf8");

// --- Issue #7 — `add` create path ----------------------------------------------

// A new skill gains a CHANGELOG.md next to its SKILL.md: header, a v1.0.0
// first entry projecting the stamps (from/source), and — when given — the
// relation. Stamping itself is unchanged.
test("add writes a CHANGELOG.md with a first entry for a new skill", async () => {
  const sb = await createSandbox();
  try {
    const body = "# Fresh skill\n";
    const planted = await plantSkill(sb.home, "incoming/fresh", { body });

    const { stdout, exitCode } = await runCli(sb.home, [
      "add",
      planted.dir,
      "--relation",
      "A/B variant of gamma",
    ]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readStoredChangelog(sb.home, "fresh");
    assert.match(
      changelog,
      /^# Changelog — fresh\n/,
      `generated header, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes(`## v1.0.0 (${today()})`),
      `version entry, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes(`- Ingested by Skill Ninja from "${planted.dir}" (source: received).`),
      `from/source line, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes('- Relation: "A/B variant of gamma".'),
      `relation line, got:\n${changelog}`,
    );

    // Stamping is unaffected: the SKILL.md hash is still the independent
    // body hash, and no changelog bytes leaked into SKILL.md.
    const skill = await readFile(join(storePath(sb.home), "fresh", "SKILL.md"), "utf8");
    assert.ok(skill.includes(`hash: ${sha256(body)}`), `stamps unchanged, got:\n${skill}`);
    assert.ok(!skill.includes("Changelog"), `SKILL.md carries no changelog, got:\n${skill}`);
  } finally {
    await sb.cleanup();
  }
});

// An incoming skill that already carries its own CHANGELOG.md keeps that
// content: the author's prose (here including a maintenance-notes section) is
// preserved verbatim beneath the generated header — its own H1 is dropped, not
// duplicated — and the generated entry appends BELOW the author content.
test("add preserves an incoming author changelog above the generated entry", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/authored", { body: "# Authored\n" });
    await writeFile(
      join(planted.dir, "CHANGELOG.md"),
      [
        "# Changelog — authored (author's own file)",
        "",
        "## v1.0 (01.01.2026)",
        "- Erstfassung aus dem Framework-X-Workshop.",
        "",
        "### Wartungshinweis",
        "Zeitabhängige Schwellen ab 2027 gegen Primärquellen prüfen.",
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readStoredChangelog(sb.home, "authored");
    // Generated header replaces the author H1 (no duplicated heading).
    assert.match(changelog, /^# Changelog — authored\n/, `header, got:\n${changelog}`);
    assert.equal(
      changelog.indexOf("author's own file"),
      -1,
      `author H1 text dropped, got:\n${changelog}`,
    );
    // Author prose and maintenance section preserved verbatim.
    assert.ok(
      changelog.includes("- Erstfassung aus dem Framework-X-Workshop."),
      `author entry preserved, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes("### Wartungshinweis") &&
        changelog.includes("Zeitabhängige Schwellen ab 2027 gegen Primärquellen prüfen."),
      `maintenance notes preserved, got:\n${changelog}`,
    );
    // The generated entry appends below the author content.
    assert.ok(
      changelog.indexOf("Erstfassung") < changelog.indexOf(`## v1.0.0 (${today()})`),
      `generated entry below author content, got:\n${changelog}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// A skill with NO incoming changelog gets the plain generated form; a
// subdirectory CHANGELOG.md is a bundled reference asset and still travels.
test("add creates a plain changelog when the source carries none, and a nested changelog stays an asset", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/plain", { body: "# Plain\n" });
    await mkdir(join(planted.dir, "references"), { recursive: true });
    await writeFile(join(planted.dir, "references", "CHANGELOG.md"), "reference history\n", "utf8");

    const { exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0);

    const changelog = await readStoredChangelog(sb.home, "plain");
    assert.ok(changelog.startsWith("# Changelog — plain\n"), `header, got:\n${changelog}`);
    assert.ok(changelog.includes(`## v1.0.0 (${today()})`), `entry, got:\n${changelog}`);
    // The nested file is an ordinary bundled asset, untouched by the writer.
    assert.equal(
      await readFile(join(storePath(sb.home), "plain", "references", "CHANGELOG.md"), "utf8"),
      "reference history\n",
      "nested changelog copied verbatim as an asset",
    );
  } finally {
    await sb.cleanup();
  }
});

// The changelog travels in the same commit as the skill (one approval unit).
test("add commits the CHANGELOG.md with the skill", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    const planted = await plantSkill(sb.home, "incoming/gitchanged", { body: "# Git + changelog\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const files = execFileSync(
      "git",
      ["-C", storePath(sb.home), "show", "--pretty=format:", "--name-only", "HEAD"],
      { encoding: "utf8" },
    ).split(/\r?\n/);
    assert.ok(
      files.includes("gitchanged/SKILL.md"),
      `SKILL.md committed, got:\n${files.join("\n")}`,
    );
    assert.ok(
      files.includes("gitchanged/CHANGELOG.md"),
      `CHANGELOG.md committed, got:\n${files.join("\n")}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// A prompt source gets its changelog too (from "prompt").
test("add writes a changelog for a prompt source", async () => {
  const sb = await createSandbox();
  try {
    const { stdout, exitCode } = await runCli(sb.home, [
      "add",
      "--prompt",
      "# Prompted\n",
      "--name",
      "prompted-log",
    ]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    const changelog = await readStoredChangelog(sb.home, "prompted-log");
    assert.ok(
      changelog.includes('- Ingested by Skill Ninja from "prompt" (source: received).'),
      `prompt from line, got:\n${changelog}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Issue #8 — `add` update path ----------------------------------------------

// A changed re-add (the PATCH bump) appends a v1.0.1 entry: the distinct
// change counts (computed independently here from the known bodies), the
// superseded prior hash in short form, and the carried-forward relation. The
// first entry stays untouched above it.
test("add appends a version entry with change counts on a changed re-add", async () => {
  const sb = await createSandbox();
  try {
    const v1body = "# v1 body\n";
    const v2body = "# v2 body\nsecond line\n";
    const v1 = await plantSkill(sb.home, "incoming-1/updater", { body: v1body });
    const v2 = await plantSkill(sb.home, "incoming-2/updater", { body: v2body });

    await runCli(sb.home, ["add", v1.dir, "--relation", "A/B variant of gamma"]);
    const { stdout, exitCode } = await runCli(sb.home, ["add", v2.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readStoredChangelog(sb.home, "updater");
    // Chronological: the 1.0.0 entry stays above the appended 1.0.1 entry.
    assert.ok(
      changelog.indexOf("## v1.0.0") < changelog.indexOf(`## v1.0.1 (${today()})`),
      `entry order, got:\n${changelog}`,
    );
    // Counts from the known bodies: "# v1 body"→"# v2 body" is a change (1),
    // "second line" an addition (1) — the same counting `diff` reports.
    assert.ok(
      changelog.includes("- Content update: 1 line added, 0 lines removed, 1 line changed."),
      `counts line, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes(`- Supersedes prior content, hash ${shortHash(sha256(v1body))}.`),
      `superseded hash, got:\n${changelog}`,
    );
    // The relation carries forward into the update entry (the stamped value).
    assert.ok(
      changelog.includes('- Relation: "A/B variant of gamma".'),
      `carried relation, got:\n${changelog}`,
    );
    // The first entry's bytes are untouched — append-only.
    assert.ok(
      changelog.includes("- Ingested by Skill Ninja from"),
      `first entry intact, got:\n${changelog}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// An identical re-add (the version-stamp no-op) leaves the changelog
// byte-identical.
test("add leaves the changelog byte-identical on an identical re-add", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, "incoming/stable", { body: "# Stable\n" });
    await runCli(sb.home, ["add", planted.dir]);
    const before = await readStoredChangelog(sb.home, "stable");

    const { stdout, exitCode } = await runCli(sb.home, ["add", planted.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    const after = await readStoredChangelog(sb.home, "stable");
    assert.equal(after, before, `identical re-add must not touch the changelog`);
  } finally {
    await sb.cleanup();
  }
});

// A skill stored before the changelog feature (no CHANGELOG.md) gets one
// bootstrapped on its first changed re-add — opened with the explicit note
// that earlier history lives in the store's git log, and WITHOUT a fabricated
// entry for the versions before it.
test("add bootstraps a changelog on the first update of a pre-feature skill", async () => {
  const sb = await createSandbox();
  try {
    const v1 = await plantSkill(sb.home, "incoming-1/legacy", { body: "# Legacy v1\n" });
    const v2 = await plantSkill(sb.home, "incoming-2/legacy", { body: "# Legacy v2\n" });
    await runCli(sb.home, ["add", v1.dir]);
    // Simulate a pre-feature store: the skill is stored, but has no changelog.
    await rm(join(storePath(sb.home), "legacy", "CHANGELOG.md"));

    const { stdout, exitCode } = await runCli(sb.home, ["add", v2.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readStoredChangelog(sb.home, "legacy");
    assert.match(changelog, /^# Changelog — legacy\n/, `header, got:\n${changelog}`);
    assert.ok(
      changelog.includes("earlier history lives in the canonical store's git log"),
      `bootstrap note, got:\n${changelog}`,
    );
    assert.ok(
      changelog.includes(`## v1.0.1 (${today()})`),
      `update entry present, got:\n${changelog}`,
    );
    // Nothing retro-fabricated: no invented 1.0.0 entry.
    assert.ok(!changelog.includes("## v1.0.0"), `no fabricated first entry, got:\n${changelog}`);
  } finally {
    await sb.cleanup();
  }
});

// The author preamble (including a maintenance-notes section) survives an
// append verbatim — the update touches only the tail of the file.
test("add preserves the author preamble and maintenance notes across the append", async () => {
  const sb = await createSandbox();
  try {
    const v1 = await plantSkill(sb.home, "incoming-1/preserved", { body: "# Preserved v1\n" });
    await writeFile(
      join(v1.dir, "CHANGELOG.md"),
      [
        "# Changelog — preserved",
        "",
        "### Wartungshinweis",
        "Zeitabhängige Schwellen ab 2027 gegen Primärquellen prüfen.",
        "",
      ].join("\n"),
      "utf8",
    );
    await runCli(sb.home, ["add", v1.dir]);
    const before = await readStoredChangelog(sb.home, "preserved");

    const v2 = await plantSkill(sb.home, "incoming-2/preserved", { body: "# Preserved v2\n" });
    const { stdout, exitCode } = await runCli(sb.home, ["add", v2.dir]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const after = await readStoredChangelog(sb.home, "preserved");
    assert.ok(
      after.startsWith(before.slice(0, -1)) || after.startsWith(before),
      `existing content preserved verbatim at the top,\nbefore:\n${before}\nafter:\n${after}`,
    );
    assert.ok(
      after.includes("### Wartungshinweis") &&
        after.includes("Zeitabhängige Schwellen ab 2027 gegen Primärquellen prüfen."),
      `maintenance notes survive, got:\n${after}`,
    );
    assert.ok(
      after.includes(`## v1.0.1 (${today()})`),
      `appended entry, got:\n${after}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Issue #9 — `ingest --apply` bulk path --------------------------------------

// Stored winners get a CHANGELOG.md whose first entry names the batch, and a
// cluster winner also records the superseded lineage (the divergent losers'
// hashes — computed independently here from the known bodies). A solo winner
// has no lineage line.
test("ingest --apply writes batch changelogs for stored winners", async () => {
  const sb = await createSandbox();
  try {
    await mkdir(join(sb.home, "export"), { recursive: true });
    const alphaV1Body = "# Alpha v1\n";
    await plantSkill(sb.home, "export/alpha", { body: alphaV1Body });
    await plantSkill(sb.home, "export/alpha-v2", { body: "# Alpha v2\n" });
    await plantSkill(sb.home, "export/beta", { body: "# Beta\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // Cluster winner (alpha-v2 won on the v2 signal, alpha superseded).
    const alpha = await readFile(join(storePath(sb.home), "alpha", "CHANGELOG.md"), "utf8");
    assert.match(alpha, /^# Changelog — alpha\n/, `header, got:\n${alpha}`);
    assert.ok(alpha.includes(`## v1.0.0 (${today()})`), `entry, got:\n${alpha}`);
    assert.ok(
      alpha.includes('- Bulk ingested from batch "export" (source: received).'),
      `batch line, got:\n${alpha}`,
    );
    assert.ok(
      alpha.includes(`- Won its cluster over 1 superseded variant: ${shortHash(sha256(alphaV1Body))}.`),
      `lineage line, got:\n${alpha}`,
    );

    // Solo winner: no lineage line.
    const beta = await readFile(join(storePath(sb.home), "beta", "CHANGELOG.md"), "utf8");
    assert.ok(
      beta.includes('- Bulk ingested from batch "export" (source: received).'),
      `batch line, got:\n${beta}`,
    );
    assert.ok(!beta.includes("Won its cluster"), `no lineage line, got:\n${beta}`);
  } finally {
    await sb.cleanup();
  }
});

// The batch's single commit includes the changelog files — the changelog and
// the content it describes are one approval unit (issue #9 AC).
test("ingest --apply lands the changelogs in the batch's single commit", async () => {
  const sb = await createSandbox();
  try {
    makeStoreGitRepo(sb.home);
    await mkdir(join(sb.home, "export"), { recursive: true });
    await plantSkill(sb.home, "export/beta", { body: "# Beta\n" });
    await plantSkill(sb.home, "export/gamma", { body: "# Gamma\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const files = execFileSync(
      "git",
      ["-C", storePath(sb.home), "show", "--pretty=format:", "--name-only", "HEAD"],
      { encoding: "utf8" },
    ).split(/\r?\n/);
    for (const f of ["beta/SKILL.md", "beta/CHANGELOG.md", "gamma/SKILL.md", "gamma/CHANGELOG.md"]) {
      assert.ok(files.includes(f), `${f} in the commit, got:\n${files.join("\n")}`);
    }
  } finally {
    await sb.cleanup();
  }
});

// Re-ingesting the same directory (the already-stored no-op) leaves every
// winner's changelog byte-identical.
test("ingest --apply re-ingest leaves winner changelogs byte-identical", async () => {
  const sb = await createSandbox();
  try {
    await mkdir(join(sb.home, "export"), { recursive: true });
    await plantSkill(sb.home, "export/beta", { body: "# Beta\n" });
    await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    const before = await readFile(join(storePath(sb.home), "beta", "CHANGELOG.md"), "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /Already stored/, `already-stored notice, got:\n${stdout}`);
    const after = await readFile(join(storePath(sb.home), "beta", "CHANGELOG.md"), "utf8");
    assert.equal(after, before, "re-ingest must not touch the changelog");
  } finally {
    await sb.cleanup();
  }
});

// A prompt document wrapped into a skill (ADR-0010) gets the same batch
// changelog as a packaged winner.
test("ingest --apply writes a changelog for a wrapped prompt-document winner", async () => {
  const sb = await createSandbox();
  try {
    await mkdir(join(sb.home, "prompts"), { recursive: true });
    await writeFile(join(sb.home, "prompts", "notes.md"), "# Notizen\nErfasse Entscheidungen.\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "prompts"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readFile(join(storePath(sb.home), "notes", "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^# Changelog — notes\n/, `header, got:\n${changelog}`);
    assert.ok(
      changelog.includes('- Bulk ingested from batch "prompts" (source: received).'),
      `batch line, got:\n${changelog}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// A needs-decision cluster (stored copy differs from the incoming candidates)
// never touches the stored skill's changelog — skipping the store write skips
// the changelog write.
test("ingest --apply never touches a stored skill's changelog on a needs-decision conflict", async () => {
  const sb = await createSandbox();
  try {
    const stored = await plantSkill(sb.home, "incoming/gamma", { body: "# Gamma stored\n" });
    await runCli(sb.home, ["add", stored.dir]);
    const before = await readStoredChangelog(sb.home, "gamma");

    // Same identity (the copy marker normalizes away), different content, no
    // version signal -> needs-decision against the stored copy.
    await mkdir(join(sb.home, "export"), { recursive: true });
    await plantSkill(sb.home, "export/gamma-copy", { body: "# Gamma incoming\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /needs-decision|NEEDS DECISION|conflict/i, `conflict reported, got:\n${stdout}`);

    const after = await readStoredChangelog(sb.home, "gamma");
    assert.equal(after, before, "a needs-decision cluster must not touch the stored changelog");
  } finally {
    await sb.cleanup();
  }
});

// A winner package carrying its own CHANGELOG.md keeps that content as the
// author preamble beneath the generated header — the package root's changelog
// is store-owned, never a plain asset copy.
test("ingest --apply preserves a winner package's own changelog as the author preamble", async () => {
  const sb = await createSandbox();
  try {
    const pkg = await plantSkill(sb.home, "export/delta", { body: "# Delta\n" });
    await writeFile(
      join(pkg.dir, "CHANGELOG.md"),
      [
        "# Changelog — delta (author's own file)",
        "",
        "- Erstfassung aus dem Workshop.",
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", join(sb.home, "export"), "--apply"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const changelog = await readFile(join(storePath(sb.home), "delta", "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^# Changelog — delta\n/, `generated header, got:\n${changelog}`);
    assert.ok(
      changelog.indexOf("Erstfassung aus dem Workshop.") <
        changelog.indexOf(`## v1.0.0 (${today()})`),
      `author content above the entry, got:\n${changelog}`,
    );
  } finally {
    await sb.cleanup();
  }
});


