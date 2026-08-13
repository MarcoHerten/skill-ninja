// Black-box tests for `skill-ninja status` — the unified inventory view (Issue #4).
//
// status READS the cached inventory written by `init`; it does not re-scan the
// filesystem. So each test seeds the cache the realistic way: plant a skill
// landscape, run `init`, then run `status` and assert on its stdout. Tests never
// import engine code (ADR-0001).
//
// Slices: A) lists every skill + location; B) duplicates flagged; C) broken
// symlinks flagged distinctly; D) version/provenance shown where known;
// E) filters (--broken / --duplicates / --personal); plus the no-inventory case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createSandbox, runCli, plantSkill, plantBrokenSymlink } from "./helpers/harness.js";

// Seed the cache by running init, then run status and return its result.
async function seedAndStatus(sb, statusArgs = []) {
  const init = await runCli(sb.home, ["init"]);
  assert.equal(init.exitCode, 0, `init failed while seeding; stderr:\n${init.stderr}`);
  return runCli(sb.home, ["status", ...statusArgs]);
}

// Slice A — every skill is listed once with its location(s) and human scan-root labels.
test("status lists every skill with its location and scan-root label", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/claude-skill");
    await plantSkill(sb.home, ".zcode/skills/zcode-skill");
    await plantSkill(sb.home, "Documents/Obsidian Vault/notes/vault-skill");

    const { stdout, exitCode } = await seedAndStatus(sb);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /Skill Ninja status/, `expected a header, got:\n${stdout}`);

    // Each skill name appears once (grouped, not duplicated per occurrence).
    for (const name of ["claude-skill", "zcode-skill", "vault-skill"]) {
      assert.ok(stdout.includes(name), `expected ${name} listed, got:\n${stdout}`);
    }

    // Human scan-root labels and the skill directory (location) are shown.
    assert.match(stdout, /Claude root/, `expected the Claude scan-root label, got:\n${stdout}`);
    assert.match(stdout, /ZCode root/, `expected the ZCode scan-root label, got:\n${stdout}`);
    assert.ok(
      stdout.includes(join(sb.home, ".claude", "skills", "claude-skill")),
      `expected the skill location, got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice B — the same skill in more than one location is flagged as a duplicate,
// shown once with both locations.
test("status flags a skill present in multiple roots as a duplicate with each location", async () => {
  const sb = await createSandbox();
  try {
    // Same logical skill (name "shared") in two agent roots -> tool asymmetry.
    await plantSkill(sb.home, ".claude/skills/shared");
    await plantSkill(sb.home, ".zcode/skills/shared");
    // A second, unique skill that must NOT be flagged.
    await plantSkill(sb.home, ".claude/skills/only-here");

    const { stdout, exitCode } = await seedAndStatus(sb);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /\[duplicate\]/, `expected a duplicate flag, got:\n${stdout}`);
    assert.ok(stdout.includes("shared"), `expected the duplicated skill name, got:\n${stdout}`);

    // Both locations of the duplicate are shown.
    assert.ok(
      stdout.includes(join(sb.home, ".claude", "skills", "shared")),
      `expected the Claude location of the duplicate, got:\n${stdout}`,
    );
    assert.ok(
      stdout.includes(join(sb.home, ".zcode", "skills", "shared")),
      `expected the ZCode location of the duplicate, got:\n${stdout}`,
    );

    // The unique skill is listed but not marked duplicate.
    assert.ok(stdout.includes("only-here"));
    const onlyLine = stdout.split("\n").find((l) => l.includes("only-here"));
    assert.ok(onlyLine, `expected an only-here line, got:\n${stdout}`);
    assert.doesNotMatch(onlyLine, /\[duplicate\]/, `unique skill must not be flagged, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — a broken symlink is flagged distinctly, separate from real skills.
test("status flags broken symlinks distinctly with their path and scan root", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/good-skill");
    const broken = await plantBrokenSymlink(sb.home, ".claude/skills/dangling-skill");

    const { stdout, exitCode } = await seedAndStatus(sb);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /\[broken symlink\]/, `expected a broken marker, got:\n${stdout}`);
    assert.ok(
      stdout.includes(broken.link),
      `expected the broken symlink path, got:\n${stdout}`,
    );
    assert.match(stdout, /Claude root/, `expected the broken link's scan-root label, got:\n${stdout}`);

    // The real skill is still listed alongside the broken link.
    assert.ok(stdout.includes("good-skill"), `expected the good skill too, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice D — version and provenance are shown where known; absent fields read as
// "unknown" (never crash, never dump raw JSON).
test("status shows version and provenance where known, and unknown where absent", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/stamped", {
      frontmatter: {
        name: "stamped",
        version: "1.4.0",
        updated: "2026-07-01",
        provenance: { source: "authored", from: "Marco", imported: "2026-06-01", derived_from: null },
      },
    });
    await plantSkill(sb.home, ".claude/skills/bare");

    const { stdout, exitCode } = await seedAndStatus(sb);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // Known version + provenance source/from are surfaced as plain text.
    assert.match(stdout, /1\.4\.0/, `expected the stamped version, got:\n${stdout}`);
    assert.match(stdout, /authored/, `expected the provenance source, got:\n${stdout}`);
    assert.match(stdout, /Marco/, `expected the provenance 'from', got:\n${stdout}`);

    // The bare skill shows "unknown" rather than raw null/JSON.
    assert.match(stdout, /unknown/, `expected an 'unknown' for the bare skill, got:\n${stdout}`);
    assert.doesNotMatch(stdout, /"version": null/, `no raw JSON dumps, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice E — filters narrow the view.
test("--broken shows only broken symlinks (no skills section)", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/good-skill");
    await plantBrokenSymlink(sb.home, ".claude/skills/dangling-skill");

    const { stdout, exitCode } = await seedAndStatus(sb, ["--broken"]);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.match(stdout, /\[broken symlink\]/, `expected the broken link, got:\n${stdout}`);
    // Skills are hidden under --broken.
    assert.ok(!stdout.includes("good-skill"), `skills must be hidden under --broken, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

test("--duplicates shows only skills with more than one location", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/shared");
    await plantSkill(sb.home, ".zcode/skills/shared");
    await plantSkill(sb.home, ".claude/skills/only-here");

    const { stdout, exitCode } = await seedAndStatus(sb, ["--duplicates"]);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.ok(stdout.includes("shared"), `expected the duplicate, got:\n${stdout}`);
    assert.match(stdout, /\[duplicate\]/, `expected the duplicate flag, got:\n${stdout}`);
    // The unique skill is filtered out.
    assert.ok(!stdout.includes("only-here"), `unique skill must be hidden, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

test("--personal shows only Personal skills (authored or in the canonical store)", async () => {
  // Configure the canonical store and ALSO scan it as a project so an
  // owned-in-store skill is discovered by init. (ADR-0004: Personal heuristic.)
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude"],
      vaults: [],
      projects: ["~/.skill-ninja/store"],
    },
  });
  try {
    // Personal via the store path (lives under config.store, no provenance).
    await plantSkill(sb.home, ".skill-ninja/store/owned-skill");
    // Personal via provenance (authored), living in an agent root.
    await plantSkill(sb.home, ".claude/skills/authored-skill", {
      frontmatter: { name: "authored-skill", provenance: { source: "authored" } },
    });
    // Not personal: external source, agent root.
    await plantSkill(sb.home, ".claude/skills/external-skill", {
      frontmatter: { name: "external-skill", provenance: { source: "external" } },
    });

    const { stdout, exitCode } = await seedAndStatus(sb, ["--personal"]);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    assert.ok(stdout.includes("owned-skill"), `expected the store-owned personal skill, got:\n${stdout}`);
    assert.ok(stdout.includes("authored-skill"), `expected the authored personal skill, got:\n${stdout}`);
    assert.ok(!stdout.includes("external-skill"), `non-personal skill must be hidden, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// No cache yet — status points the user at init and exits 0 (it does not crash
// or silently re-scan).
test("status with no inventory tells the user to run init first and exits 0", async () => {
  const sb = await createSandbox();
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["status"]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.ok(
      stdout.includes(join(sb.home, ".skill-ninja", "inventory.json")),
      `expected the missing inventory path, got:\n${stdout}`,
    );
    assert.match(stdout, /init/i, `expected an init hint, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});
