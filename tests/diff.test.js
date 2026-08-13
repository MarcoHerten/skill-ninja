// Black-box tests for `ninja diff` (Issue #5 / T5) — compare a stored
// Skill against a candidate version. Tests seed the store with `add`, then run
// `diff` and assert on stdout + exit code only. Expected hashes/counts come from
// INDEPENDENT reasoning (a sha256 computed in the test from known content, or a
// hand-counted expectation for a known v1→v2 pair), never from engine code.
// (ADR-0001 seam; ADR-0005 stamping + content-hash contract.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  createSandbox,
  runCli,
  plantSkill,
  storePath,
  makeLocalSkillRepo,
  readStoredSkill,
  parseStamps,
} from "./helpers/harness.js";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Helper: `add` a skill to the store (v1), returning once it is canonical.
async function addStored(home, dir) {
  const { stdout, exitCode } = await runCli(home, ["add", dir]);
  assert.equal(exitCode, 0, `add seed failed, stdout:\n${stdout}`);
}

// Slice A — a stored v1 diffed against an incoming v2 (changed content) shows a
// readable diff: a header naming stored vs incoming, a DIFFERS verdict, and `-`
// / `+` lines. (The "friend sent v2 — what's new?" case.)
test("diff shows stored-vs-incoming header, DIFFERS, and +/- lines for changed content", async () => {
  const sb = await createSandbox();
  try {
    const v1body = "# v1 body\n";
    const v2body = "# v2 body\nsecond line\n";
    const v1 = await plantSkill(sb.home, "incoming-1/foo", { body: v1body });
    const v2 = await plantSkill(sb.home, "incoming-2/foo", { body: v2body });
    await addStored(sb.home, v1.dir);

    const { stdout, exitCode } = await runCli(sb.home, ["diff", "foo", v2.dir]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    // Header names both sides and reports the verdict.
    assert.match(stdout, /diff 'foo'/, `expected a diff header, got:\n${stdout}`);
    assert.match(stdout, /stored version 1\.0\.0/, `expected stored version, got:\n${stdout}`);
    assert.match(stdout, /vs incoming/, `expected 'vs incoming', got:\n${stdout}`);
    assert.match(stdout, /content DIFFERS/, `expected DIFFERS verdict, got:\n${stdout}`);
    // The unified block shows the removed and added lines.
    assert.ok(stdout.includes("- # v1 body"), `expected removed line, got:\n${stdout}`);
    assert.ok(stdout.includes("+ # v2 body"), `expected added line, got:\n${stdout}`);
    assert.ok(stdout.includes("+ second line"), `expected the new line, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice B — an incoming candidate whose body matches the stored body reports a
// match, shows NO diff block, and exits 0. (Same content hash.)
test("diff reports a match with no diff block when the candidate equals the stored version", async () => {
  const sb = await createSandbox();
  try {
    const body = "# Same body\n";
    const v1 = await plantSkill(sb.home, "incoming-1/same", { body });
    const same = await plantSkill(sb.home, "incoming-2/same", { body });
    await addStored(sb.home, v1.dir);

    const { stdout, exitCode } = await runCli(sb.home, ["diff", "same", same.dir]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /content MATCHES/, `expected MATCHES verdict, got:\n${stdout}`);
    assert.match(stdout, /no content changes/i, `expected a no-changes line, got:\n${stdout}`);
    // No unified diff block: no +/- prefixed lines.
    assert.doesNotMatch(stdout, /^[+-] /m, `expected no diff block, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — a repo/URL candidate is cloned (offline via a local .git repo) and
// diffed against the stored version. (The upstream/external-version case.)
test("diff accepts a repo/URL candidate by cloning it and diffs against the stored version", async () => {
  const sb = await createSandbox();
  try {
    const v1body = "# Stored copy\n";
    const v1 = await plantSkill(sb.home, "incoming-1/upstream-skill", { body: v1body });
    await addStored(sb.home, v1.dir);

    // A local git repo whose SKILL.md body differs — ends in .git so the engine
    // treats it as a repo source and clones it (no network).
    const repoBody = "# Upstream copy\nnew upstream line\n";
    const repoPath = makeLocalSkillRepo(join(sb.home, "incoming", "upstream.git"), {
      name: "upstream-skill",
      body: repoBody,
    });

    const { stdout, exitCode } = await runCli(sb.home, ["diff", "upstream-skill", repoPath]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.match(stdout, /content DIFFERS/, `expected DIFFERS, got:\n${stdout}`);
    assert.ok(stdout.includes("- # Stored copy"), `expected removed stored line, got:\n${stdout}`);
    assert.ok(stdout.includes("+ # Upstream copy"), `expected added upstream line, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice D — the change summary distinguishes added / removed / changed counts,
// matching an independently hand-counted expectation for a known v1→v2 pair.
test("diff summary counts added / removed / changed lines distinctly", async () => {
  const sb = await createSandbox();
  try {
    // v1 → v2 has, by independent reasoning:
    //   - 1 pure removal      ("remove me" deleted, neighbours kept)
    //   - 1 modification      ("change me" -> "changed!", a removed line
    //                          immediately followed by an added line)
    //   - 1 pure addition     ("add me" inserted, neighbours kept)
    const v1body =
      "# Diff skill\nkeep one\nremove me\nkeep two\nchange me\nkeep three\n";
    const v2body =
      "# Diff skill\nkeep one\nkeep two\nchanged!\nkeep three\nadd me\n";
    const v1 = await plantSkill(sb.home, "incoming-1/counter", { body: v1body });
    const v2 = await plantSkill(sb.home, "incoming-2/counter", { body: v2body });
    await addStored(sb.home, v1.dir);

    const { stdout, exitCode } = await runCli(sb.home, ["diff", "counter", v2.dir]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    // The summary states each count distinctly, matching the hand count above.
    assert.match(stdout, /Summary: 1 line added, 1 line removed, 1 line changed\./, `expected the counted summary, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice E — diffing a name that is NOT in the store gives a clear, plain-
// language error, exits non-zero, and points the user to `add`.
test("diff of an unknown skill name errors, exits non-zero, and points to add", async () => {
  const sb = await createSandbox();
  try {
    const candidate = await plantSkill(sb.home, "incoming/whatever", { body: "# x\n" });

    const { stdout, stderr, exitCode } = await runCli(sb.home, [
      "diff",
      "no-such-skill",
      candidate.dir,
    ]);

    assert.notEqual(exitCode, 0, `expected non-zero exit, got ${exitCode}`);
    const combined = stdout + stderr;
    assert.ok(/no-such-skill/.test(combined), `expected the unknown name echoed, got:\n${combined}`);
    assert.match(combined, /\badd\b/, `expected a hint to run 'add', got:\n${combined}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice F — `diff <name>` with NO candidate prints clear guidance (the store
// copy is the baseline; a candidate is required) and exits non-zero.
test("diff without a candidate prints guidance and exits non-zero", async () => {
  const sb = await createSandbox();
  try {
    const v1 = await plantSkill(sb.home, "incoming-1/lonely", { body: "# lonely\n" });
    await addStored(sb.home, v1.dir);

    const { stdout, exitCode } = await runCli(sb.home, ["diff", "lonely"]);

    assert.notEqual(exitCode, 0, `expected non-zero exit, got ${exitCode}`);
    assert.match(stdout, /candidate/i, `expected guidance mentioning a candidate, got:\n${stdout}`);
    assert.match(stdout, /ninja diff lonely <candidate>/, `expected a usage hint, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice G — the header reports the content hashes of both sides; the stored
// hash equals the sha256 of the stored body (independently computed), and the
// incoming hash equals the sha256 of the candidate body.
test("diff header shows both content hashes matching independently-computed values", async () => {
  const sb = await createSandbox();
  try {
    const v1body = "# Hashed one\n";
    const v2body = "# Hashed two\n";
    const v1 = await plantSkill(sb.home, "incoming-1/hashed", { body: v1body });
    const v2 = await plantSkill(sb.home, "incoming-2/hashed", { body: v2body });
    await addStored(sb.home, v1.dir);

    // Sanity: the stored stamp hash equals sha256(stored body), per ADR-0005.
    const stamps = parseStamps(await readStoredSkill(sb.home, "hashed"));
    assert.equal(stamps.hash, sha256(v1body), `stamped hash should equal body hash`);

    const { stdout } = await runCli(sb.home, ["diff", "hashed", v2.dir]);

    const storedShort = sha256(v1body).slice(0, 8);
    const incomingShort = sha256(v2body).slice(0, 8);
    assert.ok(
      stdout.includes(storedShort),
      `expected stored hash prefix ${storedShort} in header, got:\n${stdout}`,
    );
    assert.ok(
      stdout.includes(incomingShort),
      `expected incoming hash prefix ${incomingShort} in header, got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});
