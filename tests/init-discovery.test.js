// Black-box tests for `ninja init` — the machine analysis / cached
// inventory (ADR-0003). Tests plant a skill landscape in a sandboxed fake $HOME,
// run the CLI, and assert on stdout + the written inventory cache file. They
// never import engine code (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, runCli, plantSkill, plantBrokenSymlink } from "./helpers/harness.js";

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

// Slice A — a single skill in an agent root is discovered, written to the cache,
// and reported on stdout.
test("init discovers a skill in an agent root and writes the inventory cache", async () => {
  const sb = await createSandbox();
  try {
    const planted = await plantSkill(sb.home, ".claude/skills/my-skill");

    const { stdout, exitCode } = await runCli(sb.home, ["init"]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    const cache = await readInventory(sb.home);

    const found = cache.skills.find((s) => s.name === "my-skill");
    assert.ok(found, `expected my-skill in inventory, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.file, planted.file);
    assert.equal(found.scanRoot.kind, "agent");
    assert.equal(found.scanRoot.ref, "claude");
    assert.equal(found.scanRoot.root, join(sb.home, ".claude", "skills"));

    assert.match(stdout, /1 skill/i, `expected a skill count in stdout, got:\n${stdout}`);
    assert.ok(
      stdout.includes(join(sb.home, ".skill-ninja", "inventory.json")),
      `expected the cache path in stdout, got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice B — skills planted across multiple scan roots (two agent roots, a vault,
// and a project dir) all appear, each tagged with its correct scan root/location.
test("init discovers skills across multiple scan roots and tags each with its scan root", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude", "zcode"],
      vaults: ["~/Documents/Vault"],
      projects: ["~/code/myapp"],
    },
  });
  try {
    await plantSkill(sb.home, ".claude/skills/claude-skill");
    await plantSkill(sb.home, ".zcode/skills/zcode-skill");
    await plantSkill(sb.home, "Documents/Vault/Notes/vault-skill");
    await plantSkill(sb.home, "code/myapp/project-skill");

    const { stdout, exitCode } = await runCli(sb.home, ["init"]);

    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    const cache = await readInventory(sb.home);

    assert.equal(cache.skills.length, 4, `expected 4 skills, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(cache.counts.skills, 4);

    const byName = Object.fromEntries(cache.skills.map((s) => [s.name, s]));

    assert.equal(byName["claude-skill"].scanRoot.kind, "agent");
    assert.equal(byName["claude-skill"].scanRoot.ref, "claude");
    assert.equal(byName["claude-skill"].file, join(sb.home, ".claude", "skills", "claude-skill", "SKILL.md"));

    assert.equal(byName["zcode-skill"].scanRoot.kind, "agent");
    assert.equal(byName["zcode-skill"].scanRoot.ref, "zcode");

    assert.equal(byName["vault-skill"].scanRoot.kind, "vault");
    assert.equal(byName["vault-skill"].scanRoot.ref, join(sb.home, "Documents", "Vault"));

    assert.equal(byName["project-skill"].scanRoot.kind, "project");
    assert.equal(byName["project-skill"].scanRoot.ref, join(sb.home, "code", "myapp"));

    assert.match(stdout, /4 skills/i, `expected 4 skills reported, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice C — version/provenance frontmatter is detected where present; absent
// fields are recorded as null (never thrown on a bare SKILL.md).
test("init detects version/provenance from frontmatter and records null when absent", async () => {
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

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const byName = Object.fromEntries(cache.skills.map((s) => [s.name, s]));

    const stamped = byName["stamped"];
    assert.equal(stamped.version, "1.4.0");
    assert.equal(stamped.updated, "2026-07-01");
    assert.deepEqual(stamped.provenance, {
      source: "authored",
      from: "Marco",
      imported: "2026-06-01",
      derived_from: null,
    });

    const bare = byName["bare"];
    assert.equal(bare.version, null);
    assert.equal(bare.updated, null);
    assert.equal(bare.provenance, null);
  } finally {
    await sb.cleanup();
  }
});

// Slice D — a broken symlink in an agent root is recorded (not dropped, not a
// crash); init still exits 0.
test("init records a broken symlink and exits 0 without crashing", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/good-skill");
    const broken = await plantBrokenSymlink(sb.home, ".claude/skills/dangling-skill");

    const { stdout, exitCode } = await runCli(sb.home, ["init"]);

    assert.equal(exitCode, 0, `expected exit 0 despite a broken symlink, stderr:\n${stdout}`);
    const cache = await readInventory(sb.home);

    const found = cache.broken.find((b) => b.path === broken.link);
    assert.ok(found, `expected the broken symlink in cache.broken, got:\n${JSON.stringify(cache.broken)}`);
    assert.equal(found.scanRoot.kind, "agent");
    assert.equal(found.scanRoot.ref, "claude");

    // The good skill is still discovered alongside the broken link.
    assert.ok(cache.skills.find((s) => s.name === "good-skill"));
    assert.match(stdout, /1 broken symlink/i, `expected a broken-symlink count, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// Idempotency — running init twice overwrites the cache with a fresh scan (no
// stale entries when the landscape changes).
test("init is idempotent: re-running reflects the current landscape", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/first");
    await runCli(sb.home, ["init"]);
    let cache = await readInventory(sb.home);
    assert.equal(cache.skills.length, 1);

    await plantSkill(sb.home, ".claude/skills/second");
    await runCli(sb.home, ["init"]);
    cache = await readInventory(sb.home);

    assert.equal(cache.skills.length, 2);
    assert.ok(cache.skills.find((s) => s.name === "second"));
  } finally {
    await sb.cleanup();
  }
});

// ADR-0008 — the agent-root map follows skills.sh's conventions (not just the
// original 3). A skill in a `.codex/skills` root is discovered and tagged with
// the codex scan root, proving the expanded map resolves end-to-end.
test("init discovers skills in an expanded agent root (codex) via skills.sh conventions", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["codex"],
      vaults: [],
      projects: [],
    },
  });
  try {
    await plantSkill(sb.home, ".codex/skills/codex-skill");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "codex-skill");
    assert.ok(found, `expected codex-skill, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.scanRoot.kind, "agent");
    assert.equal(found.scanRoot.ref, "codex");
    assert.equal(found.scanRoot.root, join(sb.home, ".codex", "skills"));

    // The status view labels the expanded agent family.
    const { stdout } = await runCli(sb.home, ["status"]);
    assert.match(stdout, /Codex root/, `expected the Codex scan-root label, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

