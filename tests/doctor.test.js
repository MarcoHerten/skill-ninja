// Black-box tests for `ninja doctor` (Issue #6 / T6) — detect problems,
// propose repairs, and apply them only with approval. Tests plant a messy skill
// landscape in a sandboxed fake $HOME, run `init` to cache the inventory, then
// run `doctor` and assert on stdout + the resulting filesystem only.
//
// The "no silent changes" guarantee is asserted explicitly: a plain `doctor`
// (no --apply) MUST leave the landscape untouched. (ADR-0001 seam; ADR-0006.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, readlink, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  plantBrokenSymlink,
  plantDuplicate,
  storePath,
} from "./helpers/harness.js";

// --- filesystem assertion helpers (independent of engine code) --------------

async function isSymlink(p) {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

// A real directory (not a symlink) — i.e. a loose copy, the state doctor repairs.
async function isRealDir(p) {
  try {
    const st = await lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// A symlink entry still exists (lstat does not follow — so a dangling link reads
// as present here even though existsSync would be false).
async function entryExists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Build the messy landscape slices A/B/C share: a duplicate (same skill, loose,
// in two roots), a solo orphan (loose), and a broken symlink. Runs `init` so the
// inventory is cached. Returns the absolute paths the assertions reason about.
async function messyLandscape(home) {
  const dupBody = "# dup body\n";
  const dup = await plantDuplicate(home, "dup", [".claude/skills/dup", ".zcode/skills/dup"], {
    body: dupBody,
  });
  const orphan = await plantSkill(home, ".claude/skills/lonely", {
    frontmatter: { name: "lonely" },
    body: "# lonely body\n",
  });
  const broken = await plantBrokenSymlink(home, ".claude/skills/dangling");

  await runCli(home, ["init"]);

  return {
    dupBody,
    dup,
    dupStore: join(storePath(home), "dup"),
    orphan,
    orphanStore: join(storePath(home), "lonely"),
    brokenLink: broken.link,
  };
}

// Slice A — plain `doctor` REPORTS all three problem types and proposes repairs,
// AND leaves the filesystem UNCHANGED (no silent changes — the dry-run guarantee).
test("doctor (dry run) reports broken, duplicates, and orphans and changes nothing", async () => {
  const sb = await createSandbox();
  try {
    const L = await messyLandscape(sb.home);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);

    // All three problem types are reported in plain language.
    assert.match(stdout, /broken symlink/i, `expected a broken-symlink section, got:\n${stdout}`);
    assert.ok(stdout.includes(L.brokenLink), `expected the broken path in stdout, got:\n${stdout}`);
    assert.match(stdout, /duplicate/i, `expected a duplicate section, got:\n${stdout}`);
    assert.ok(stdout.includes("dup"), `expected the duplicate name in stdout, got:\n${stdout}`);
    assert.match(stdout, /orphan/i, `expected an orphan section, got:\n${stdout}`);
    assert.ok(stdout.includes("lonely"), `expected the orphan name in stdout, got:\n${stdout}`);

    // Each finding proposes a repair in plain language.
    assert.match(stdout, /Proposed repair:/, `expected proposed repairs, got:\n${stdout}`);
    // The dry run explicitly says nothing was changed + how to apply.
    assert.match(stdout, /Nothing was changed/, `expected a no-change notice, got:\n${stdout}`);
    assert.match(stdout, /doctor --apply/, `expected an --apply hint, got:\n${stdout}`);

    // HARD RULE: the filesystem is untouched.
    // - broken symlink entry still present.
    assert.ok(await entryExists(L.brokenLink), "broken symlink must still exist after a dry run");
    // - duplicates still real (loose) dirs, not symlinks.
    assert.ok(await isRealDir(L.dup[0].dir), "first duplicate must still be a real dir");
    assert.ok(await isRealDir(L.dup[1].dir), "second duplicate must still be a real dir");
    assert.ok(!(await isSymlink(L.dup[0].dir)), "first duplicate must not be a symlink");
    // - orphan still a real dir.
    assert.ok(await isRealDir(L.orphan.dir), "orphan must still be a real dir");
    // - nothing was copied into the store yet.
    assert.ok(!existsSync(L.dupStore), "store must not yet hold the duplicate");
    assert.ok(!existsSync(L.orphanStore), "store must not yet hold the orphan");
  } finally {
    await sb.cleanup();
  }
});

// Slice B — `doctor --apply` repairs all three problems and prints a summary.
test("doctor --apply removes broken links, consolidates duplicates, ingests orphans, and summarizes", async () => {
  const sb = await createSandbox();
  try {
    const L = await messyLandscape(sb.home);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor", "--apply"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);

    // Broken link removed.
    assert.ok(!(await entryExists(L.brokenLink)), "broken symlink must be removed");

    // Duplicate consolidated: both loose locations are now symlinks -> <store>/dup,
    // and the canonical store copy exists with the (verbatim) body.
    for (const d of L.dup) {
      assert.ok(await isSymlink(d.dir), `${d.dir} must be a symlink after dedup`);
      assert.equal(await readlink(d.dir), L.dupStore, `${d.dir} must point at the store copy`);
    }
    const dupSkillFile = join(L.dupStore, "SKILL.md");
    assert.ok(existsSync(dupSkillFile), "canonical store copy of the duplicate must exist");
    const dupText = await readFile(dupSkillFile, "utf8");
    assert.ok(dupText.includes(L.dupBody), "store copy preserves the verbatim body");

    // Orphan ingested: its location is now a symlink -> <store>/lonely, store copy exists.
    assert.ok(await isSymlink(L.orphan.dir), "orphan location must be a symlink after ingest");
    assert.equal(await readlink(L.orphan.dir), L.orphanStore, "orphan location must point at the store copy");
    assert.ok(existsSync(join(L.orphanStore, "SKILL.md")), "canonical store copy of the orphan must exist");

    // Summary of applied changes (SPEC.md user story #21).
    assert.match(stdout, /Summary of applied changes/, `expected a summary, got:\n${stdout}`);
    assert.match(stdout, /1 broken symlink removed/, `expected 1 broken removed, got:\n${stdout}`);
    assert.ok(stdout.includes("dup") && /consolidated/.test(stdout), `expected dup consolidation in summary, got:\n${stdout}`);
    assert.ok(stdout.includes("lonely") && /ingested/.test(stdout), `expected lonely ingestion in summary, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — after `doctor --apply`, re-running `init` then `doctor` finds a
// healthy landscape (the "repairs leave a healthy landscape" AC).
test("after doctor --apply, re-init + doctor reports a healthy landscape", async () => {
  const sb = await createSandbox();
  try {
    const L = await messyLandscape(sb.home);
    await runCli(sb.home, ["doctor", "--apply"]);

    // Refresh the inventory from the repaired filesystem, then re-check.
    await runCli(sb.home, ["init"]);
    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);

    assert.match(stdout, /No problems detected/i, `expected a healthy landscape, got:\n${stdout}`);
    // The formerly-broken link is gone, so it is not reported.
    assert.ok(!stdout.includes(L.brokenLink), `broken link should no longer appear, got:\n${stdout}`);
    // The consolidated skill is no longer flagged as a duplicate (it is a healthy
    // linked spread now, not a loose-copy problem).
    assert.doesNotMatch(stdout, /duplicate/i, `no duplicate should be reported, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /orphan/i, `no orphan should be reported, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice D — with no cached inventory, doctor says so and points to init (exit 0).
test("doctor with no inventory tells the user to run init and exits 0", async () => {
  const sb = await createSandbox();
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /No Skill Ninja inventory found/i, `expected a missing-inventory notice, got:\n${stdout}`);
    assert.match(stdout, /init/i, `expected an init hint, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice E — `--only` scopes repairs: with `--only broken`, the broken link is
// removed but duplicates and orphans are left untouched.
test("doctor --apply --only broken repairs only broken links and leaves duplicates/orphans", async () => {
  const sb = await createSandbox();
  try {
    const L = await messyLandscape(sb.home);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor", "--apply", "--only", "broken"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);

    // Broken link removed.
    assert.ok(!(await entryExists(L.brokenLink)), "broken symlink must be removed");
    // Duplicates + orphan untouched (still loose real dirs; nothing in the store).
    assert.ok(await isRealDir(L.dup[0].dir), "duplicate must be untouched by --only broken");
    assert.ok(await isRealDir(L.orphan.dir), "orphan must be untouched by --only broken");
    assert.ok(!existsSync(L.dupStore), "store must not hold the duplicate under --only broken");
    // The report's summary reflects only the broken repair: it records that no
    // duplicates/orphans were touched (the accurate negative).
    assert.match(stdout, /1 broken symlink removed/, `expected only broken in summary, got:\n${stdout}`);
    assert.match(stdout, /No duplicates consolidated/, `expected no-consolidation note, got:\n${stdout}`);
    assert.match(stdout, /No orphans ingested/, `expected no-ingest note, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice F — a healthy, add-linked spread (one canonical copy + symlinks into the
// roots) is NOT flagged as a duplicate: tool asymmetry correctly handled is the
// healthy state, not a problem.
test("doctor does not flag a healthy linked spread (add-style links) as a duplicate", async () => {
  const sb = await createSandbox();
  try {
    // `add` places the canonical copy in the store and links both agent roots.
    const planted = await plantSkill(sb.home, "incoming/clean", { body: "# Clean skill\n" });
    await runCli(sb.home, ["add", planted.dir]);
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /No problems detected/i, `expected a healthy landscape, got:\n${stdout}`);
    // The linked skill appears in two roots but is not a duplicate problem.
    assert.doesNotMatch(stdout, /duplicate/i, `a linked spread must not be flagged, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice G — an invalid --only value is rejected with usage (exit non-zero).
test("doctor rejects an invalid --only value", async () => {
  const sb = await createSandbox();
  try {
    await runCli(sb.home, ["init"]); // inventory present so we reach arg parsing
    const { stderr, exitCode } = await runCli(sb.home, ["doctor", "--only", "bogus"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /--only must be broken, duplicates, or orphans/);
  } finally {
    await sb.cleanup();
  }
});

// Slice H — the skills.sh install pattern: one real canonical dir in an agent
// root, the other roots symlinked into it. All occurrences resolve to ONE
// content location, so this is a healthy linked spread, not a duplicate —
// doctor must neither flag it nor, on --apply, replace skills.sh's canonical
// directory with a store symlink (the bug: doctor used to "consolidate" the
// install skills.sh owns).
test("doctor does not flag or touch a skills.sh-style canonical spread (real dir + links into it)", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude", "agents"],
      vaults: [],
      projects: [],
    },
  });
  try {
    const real = await plantSkill(sb.home, ".agents/skills/installed", {
      frontmatter: { name: "installed" },
    });
    const link = join(sb.home, ".claude/skills/installed");
    await symlink(real.dir, link);
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /No problems detected/i, `expected a healthy landscape, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /duplicate/i, `a linked spread must not be flagged, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /orphan/i, `a linked spread must not be an orphan, got:\n${stdout}`);

    // --apply must leave the skills.sh layout exactly as installed: the real
    // canonical dir stays a real dir, the agent-root symlink stays a symlink,
    // and nothing is copied into the store.
    const applied = await runCli(sb.home, ["doctor", "--apply"]);
    assert.equal(applied.exitCode, 0, `expected exit 0, stderr:\n${applied.stdout}`);
    assert.ok(await isRealDir(real.dir), "skills.sh's canonical dir must stay a real directory");
    assert.ok(await isSymlink(link), "the agent-root symlink must stay a symlink");
    assert.ok(
      !existsSync(join(storePath(sb.home), "installed")),
      "nothing may be copied into the canonical store",
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice I — skills.sh-owned (External, lockfile-attributed) skills are audited,
// never re-linked (ADR-0007): doctor proposes no dedup and no orphan repair for
// them, even when they look like loose copies.
test("doctor proposes no repairs for skills.sh-owned (External) skills", async () => {
  const sb = await createSandbox();
  try {
    // skills.sh's global lockfile attributes both skills (engine reads
    // ~/skills-lock.json for agent roots — ADR-0007/0008).
    const lock = {
      version: 1,
      skills: {
        "ext-dup": { source: "friend/repo", sourceType: "github", computedHash: "aa" },
        "ext-solo": { source: "friend/repo", sourceType: "github", computedHash: "bb" },
      },
    };
    await writeFile(join(sb.home, "skills-lock.json"), JSON.stringify(lock, null, 2) + "\n");

    // A loose two-location spread AND a solo loose copy — both External-owned.
    const dup = await plantDuplicate(sb.home, "ext-dup", [
      ".claude/skills/ext-dup",
      ".zcode/skills/ext-dup",
    ]);
    const solo = await plantSkill(sb.home, ".claude/skills/ext-solo", {
      frontmatter: { name: "ext-solo" },
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);
    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /No problems detected/i, `External skills must not be flagged, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /ext-dup/, `no duplicate finding for External skills, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /ext-solo/, `no orphan finding for External skills, got:\n${stdout}`);

    // Even --apply changes nothing for External-owned locations.
    const applied = await runCli(sb.home, ["doctor", "--apply"]);
    assert.equal(applied.exitCode, 0, `expected exit 0, stderr:\n${applied.stdout}`);
    for (const d of dup) {
      assert.ok(await isRealDir(d.dir), `${d.dir} must stay a real directory`);
    }
    assert.ok(await isRealDir(solo.dir), "the External solo copy must stay a real directory");
    assert.ok(!existsSync(join(storePath(sb.home), "ext-dup")), "store must not receive ext-dup");
    assert.ok(!existsSync(join(storePath(sb.home), "ext-solo")), "store must not receive ext-solo");
  } finally {
    await sb.cleanup();
  }
});
