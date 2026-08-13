// Black-box tests for `init` bootstrapping configuration (ADR-0008). On a fresh
// machine `init` needs NO pre-existing config: it discovers installed agents
// (existence-probe), Obsidian vaults (the vault registry), seeds
// ~/.skill-ninja/config.json, creates the canonical store (+ git init), then
// scans. Re-running re-discovers/re-seeds without clobbering hand edits.
// (ADR-0001 seam.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Fresh machine — no config. init bootstraps one from detection and scans.
test("init bootstraps a config on a fresh machine and scans the discovered roots", async () => {
  const sb = await createSandbox({ config: null });
  try {
    // Planting skills in real agent roots also creates those roots for detection.
    await plantSkill(sb.home, ".claude/skills/boot-a");
    await plantSkill(sb.home, ".zcode/skills/boot-b");

    const { stdout, exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    // Config created from detection.
    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.ok(cfg.agents.includes("claude"), `claude detected, got:\n${JSON.stringify(cfg)}`);
    assert.ok(cfg.agents.includes("zcode"), `zcode detected, got:\n${JSON.stringify(cfg)}`);
    assert.ok(typeof cfg.store === "string" && cfg.store, "store seeded");

    // Canonical store created + git init'd (first run, no remote needed).
    assert.ok(existsSync(join(cfg.store, ".git")), `store should be a git repo, store=${cfg.store}`);

    // Inventory scanned the discovered roots.
    const cache = await readJson(join(sb.home, ".skill-ninja", "inventory.json"));
    assert.ok(cache.skills.find((s) => s.name === "boot-a"), `expected boot-a, got:\n${JSON.stringify(cache.skills)}`);
    assert.ok(cache.skills.find((s) => s.name === "boot-b"));

    assert.match(stdout, /2 skills/i);
  } finally {
    await sb.cleanup();
  }
});

// Obsidian vaults are discovered from the vault registry (no config needed).
test("init discovers Obsidian vaults from the vault registry (no config needed)", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const vaultDir = join(sb.home, "Documents", "MyVault");
    await mkdir(vaultDir, { recursive: true });
    await plantSkill(sb.home, "Documents/MyVault/notes/vault-skill", { body: "# Vault skill\n" });

    // Obsidian's vault registry (platform path mirrors the engine's convention).
    const obsFile =
      process.platform === "darwin"
        ? join(sb.home, "Library/Application Support/obsidian/obsidian.json")
        : process.platform === "win32"
          ? join(sb.home, "AppData/Roaming/obsidian/obsidian.json")
          : join(sb.home, ".config/obsidian/obsidian.json");
    await mkdir(dirname(obsFile), { recursive: true });
    await writeFile(obsFile, JSON.stringify({ vaults: { x: { path: vaultDir, open: true } } }), "utf8");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.ok(cfg.vaults.includes(vaultDir), `vault discovered into config, got:\n${JSON.stringify(cfg)}`);

    const cache = await readJson(join(sb.home, ".skill-ninja", "inventory.json"));
    assert.ok(
      cache.skills.find((s) => s.name === "vault-skill"),
      `expected vault-skill scanned, got:\n${JSON.stringify(cache.skills)}`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Re-running init does not clobber a hand-edited config: agents/projects the user
// set explicitly are preserved (this is how config gets edited — ADR-0008).
test("init preserves an existing config's choices on re-run (no clobber)", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude"],
      vaults: [],
      projects: ["~/code/proj"],
    },
  });
  try {
    await plantSkill(sb.home, ".claude/skills/keep");
    await runCli(sb.home, ["init"]);

    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    // agents stay as configured (not expanded to every detected agent), projects preserved.
    assert.deepEqual(cfg.agents, ["claude"], `agents preserved, got:\n${JSON.stringify(cfg)}`);
    assert.deepEqual(cfg.projects, ["~/code/proj"], `projects preserved, got:\n${JSON.stringify(cfg)}`);
  } finally {
    await sb.cleanup();
  }
});
