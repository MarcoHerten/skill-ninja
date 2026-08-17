// Black-box tests for `ninja ingest <dir>` — the v1.1 bulk pipeline's dry-run
// analysis phase (Issue 01 / ADR-0009): every candidate in a messy source
// directory is classified (skill package in any packaging / prompt document /
// junk, each with a reason) and carries its normalized identity, nothing on
// disk is modified, and the report ends in a per-classification summary.
// Tests plant fixture directories in a sandboxed fake $HOME and assert only on
// the CLI's stdout and the filesystem (ADR-0001 seam).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir, stat, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

import { createSandbox, runCli } from "./helpers/harness.js";

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

test("ingest classifies each item with a reason and prints a summary", async () => {
  const sb = await createSandbox({ config: null }); // ingest needs no config
  try {
    const src = join(sb.home, "export");
    await plantPackage(src, "my-skill", { frontmatter: "name: my-skill\n" });
    await writeFile(join(src, "Du-bist-ein-Tester.md"), "Du bist ein Tester. Mach Tests.\n", "utf8");
    await writeFile(join(src, "anleitung.pdf"), "%PDF-1.4 fake\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["ingest", src]);

    assert.equal(exitCode, 0, `expected exit 0, stdout:\n${stdout}`);
    // One line per item, each naming its classification, its path, and a reason.
    assert.match(stdout, /skill package\s+my-skill\/\s+\(identity: my-skill\)\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /prompt document\s+Du-bist-ein-Tester\.md\s+\(identity: du-bist-ein-tester\)\s+markdown without skill structure/, `got:\n${stdout}`);
    assert.match(stdout, /junk\s+anleitung\.pdf\s+.*pdf/, `got:\n${stdout}`);
    // Summary with counts per classification.
    assert.match(stdout, /Summary: 1 skill package, 1 prompt document, 1 junk/, `got:\n${stdout}`);
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
      /skill package\s+packaged\.zip\s+\(identity: archived-skill\)\s+zip archive \(content-detected\) with skill file 'wrap\/deep\/SKILL\.md'/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /skill package\s+bundle\.skill\s+\(identity: bundle\)\s+zip archive \(content-detected\) with skill file 'SKILL-UPDATED\.md'/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /skill package\s+kalliope\.skill\.zip\s+\(identity: kalliope\)\s+zip archive \(content-detected\) with skill file 'kalliope\/kalliope-SKILL\.md'/,
      `got:\n${stdout}`,
    );
    // The fake zip is NOT treated as an archive (no magic bytes) — it is junk.
    assert.match(stdout, /junk\s+fake\.zip\s+.*zip/, `got:\n${stdout}`);
    assert.doesNotMatch(stdout, /skill package\s+fake\.zip/, `fake zip must not be a package, got:\n${stdout}`);
    // The dirty archive's __MACOSX member was filtered: no skill found -> junk.
    assert.match(stdout, /junk\s+dirty\.zip\s+archive without a SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 3 skill packages, 0 prompt documents, 2 junk/, `got:\n${stdout}`);
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
    // NFD folder -> NFC identity (both forms render alike; the comparison is
    // codepoint-exact, so an NFD identity would NOT match this NFC literal).
    const nfdLine = new RegExp(
      "skill package\\s+" + nfdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\/\\s+\\(identity: pr\u00fcfung-skill\\)",
    );
    assert.match(stdout, nfdLine, `NFD name must yield the NFC identity, got:\n${stdout}`);
    assert.match(stdout, /prompt document\s+Anti-AI-Writing-v3\.md\s+\(identity: anti-ai-writing\)/, `got:\n${stdout}`);
    assert.match(stdout, /skill package\s+Artemis Kopie 2\/\s+\(identity: artemis\)/, `got:\n${stdout}`);
    assert.match(stdout, /skill package\s+Checkliste-1\.2\.0\/\s+\(identity: checkliste\)/, `got:\n${stdout}`);
    assert.match(stdout, /prompt document\s+Reportage-2026-06-14\.md\s+\(identity: reportage\)/, `got:\n${stdout}`);
    assert.match(stdout, /skill package\s+Umsatz — Auswertung\/\s+\(identity: umsatz-auswertung\)/, `got:\n${stdout}`);
    assert.match(stdout, /prompt document\s+Notizen \(2\)\.md\s+\(identity: notizen\)/, `got:\n${stdout}`);
    assert.match(stdout, /Summary: 4 skill packages, 3 prompt documents, 0 junk/, `got:\n${stdout}`);
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
    assert.match(stdout, /Summary: 0 skill packages, 0 prompt documents, 13 junk/, `got:\n${stdout}`);
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
      /skill package \(needs-review\)\s+SKILL\.md\s+\(identity: skill\)\s+SKILL\.md file; frontmatter opening fence damaged/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /skill package \(needs-review\)\s+SKILL_BROKEN\.md\s+\(identity: skill-broken\)\s+SKILL\.md file; frontmatter never closes/,
      `got:\n${stdout}`,
    );
    assert.match(
      stdout,
      /skill package\s+kalliope-SKILL\.md\s+\(identity: kalliope\)\s+SKILL\.md file/,
      `got:\n${stdout}`,
    );
    assert.match(stdout, /Summary: 3 skill packages, 0 prompt documents, 0 junk/, `got:\n${stdout}`);
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
    assert.match(stdout, /skill package\s+toolkit\/\s+\(identity: toolkit\)\s+folder containing SKILL\.md/, `got:\n${stdout}`);
    assert.match(stdout, /skill package\s+lib\/skill-a\/\s+\(identity: skill-a\)/, `got:\n${stdout}`);
    assert.match(stdout, /skill package\s+lib\/skill-b\/\s+\(identity: skill-b\)/, `got:\n${stdout}`);
    // None of the bundled assets appears as its own line (prompt or junk).
    for (const inner of ["helper.py", "run.sh", "data.json", "big.html", "references/note.md"]) {
      assert.ok(
        !new RegExp(`^(prompt document|junk|skill package)\\s+.*${inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`, "m").test(stdout),
        `bundled asset '${inner}' must not be classified individually, got:\n${stdout}`,
      );
    }
    // The container directory itself is not an item.
    assert.doesNotMatch(stdout, /\n\w+\s+lib\/\s/, `container 'lib/' must not be listed, got:\n${stdout}`);
    assert.match(stdout, /Summary: 3 skill packages, 0 prompt documents, 0 junk/, `got:\n${stdout}`);
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

    // --apply is a designed surface but a later ticket's — it says so clearly.
    const apply = await runCli(sb.home, ["ingest", src, "--apply"]);
    assert.equal(apply.exitCode, 2);
    assert.match(apply.stderr, /--apply.*not implemented/);
  } finally {
    await sb.cleanup();
  }
});
