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
      changelog.includes(`## 1.0.0 (${today()})`),
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
      changelog.indexOf("Erstfassung") < changelog.indexOf(`## 1.0.0 (${today()})`),
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
    assert.ok(changelog.includes(`## 1.0.0 (${today()})`), `entry, got:\n${changelog}`);
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
