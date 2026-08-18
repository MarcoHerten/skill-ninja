// Black-box tests for `ninja find` (ADR-0014) — the cached-inventory search
// over skill names, descriptions, and categories, with the Availability and
// tier tags in the result lines. Tests import no engine code (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

test("find matches names, descriptions, and categories (case-insensitive)", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite", {
      frontmatter: { name: "aphrodite", category: "Marketing & Social", description: "Writes LinkedIn posts from a topic." },
    });
    await plantSkill(sb.home, ".claude/skills/mnemosyne", {
      frontmatter: { name: "mnemosyne", category: "Content & Writing", description: "Drafts encyclopedia articles." },
    });
    await runCli(sb.home, ["init"]);

    // By name (mixed case).
    const byName = await runCli(sb.home, ["find", "APHRodite"]);
    assert.equal(byName.exitCode, 0);
    assert.match(byName.stdout, /1 match/);
    assert.match(byName.stdout, /aphrodite — Writes LinkedIn posts from a topic\./);
    assert.doesNotMatch(byName.stdout, /mnemosyne/);

    // By description substring.
    const byDesc = await runCli(sb.home, ["find", "encyclopedia"]);
    assert.equal(byDesc.exitCode, 0);
    assert.match(byDesc.stdout, /mnemosyne/);
    assert.doesNotMatch(byDesc.stdout, /aphrodite/);

    // By category term — both members of the section match.
    const byCat = await runCli(sb.home, ["find", "marketing"]);
    assert.equal(byCat.exitCode, 0);
    assert.match(byCat.stdout, /Marketing & Social \(1\):/);
    assert.match(byCat.stdout, /aphrodite/);
  } finally {
    await sb.cleanup();
  }
});

test("find shows tier and availability tags, grouped by category", async () => {
  const sb = await createSandbox();
  try {
    const stored = await plantSkill(sb.home, ".skill-ninja/store/quiet", {
      frontmatter: { name: "quiet", category: "Content & Writing", description: "Whispers.", availability: "manual" },
    });
    await symlink(stored.dir, join(sb.home, ".claude/skills/quiet"));
    await plantSkill(sb.home, ".zcode/skills/loud", {
      frontmatter: { name: "loud", category: "Content & Writing", description: "Shouts." },
    });
    await runCli(sb.home, ["init"]);

    const { stdout, exitCode } = await runCli(sb.home, ["find", "quiet"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /quiet \[Personal\] \[manual\] — Whispers\./);
  } finally {
    await sb.cleanup();
  }
});

test("find with no match says so plainly; bad usage is an error", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite");
    await runCli(sb.home, ["init"]);

    const none = await runCli(sb.home, ["find", "zeppelin"]);
    assert.equal(none.exitCode, 0);
    assert.match(none.stdout, /No skill matching 'zeppelin'/);

    const noTerm = await runCli(sb.home, ["find"]);
    assert.equal(noTerm.exitCode, 2);
    assert.match(noTerm.stderr, /find needs exactly one search term/);

    const extra = await runCli(sb.home, ["find", "a", "b"]);
    assert.equal(extra.exitCode, 2);
  } finally {
    await sb.cleanup();
  }
});

test("find with no inventory points to init and exits 0", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["find", "anything"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Run `ninja init`/);
  } finally {
    await sb.cleanup();
  }
});
