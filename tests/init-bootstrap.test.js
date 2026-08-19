// Black-box tests for `init` bootstrapping configuration (ADR-0008). On a fresh
// machine `init` needs NO pre-existing config: it discovers installed agents
// (existence-probe), Obsidian vaults (the vault registry), seeds
// ~/.skill-ninja/config.json, creates the canonical store (+ git init), then
// scans. Re-running re-discovers/re-seeds without clobbering hand edits.
// (ADR-0001 seam.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// The store's commit subjects (one per line) — reading the resulting repo state
// through git is part of the black-box contract (ADR-0001: filesystem state).
function gitSubjects(store) {
  return execFileSync("git", ["-C", store, "log", "--format=%s"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
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
    // The store default is the visible ~/skill-ninja-store (ADR-0016).
    assert.equal(cfg.store, join(sb.home, "skill-ninja-store"), `visible default store, got:\n${cfg.store}`);

    // Canonical store created + git init'd (first run, no remote needed), and
    // seeded: fixed-template README + initial `init store` commit (ADR-0016).
    assert.ok(existsSync(join(cfg.store, ".git")), `store should be a git repo, store=${cfg.store}`);
    const readme = await readFile(join(cfg.store, "README.md"), "utf8");
    assert.match(readme, /# skill-ninja-store/, "README names the store");
    assert.match(readme, /canonical store/, "README says what the repo is");
    assert.match(readme, /private/i, "README carries the keep-it-private hint");
    assert.deepEqual(gitSubjects(cfg.store), ["init store"], "exactly the initial commit");

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

// Seeding is fresh-creation-only (ADR-0016): a re-run never re-seeds the README
// nor re-commits it — the user's edits to the seed README survive re-running init.
test("init re-run does not re-seed or re-commit the store README", async () => {
  const sb = await createSandbox({ config: null });
  try {
    await plantSkill(sb.home, ".claude/skills/boot-c");
    await runCli(sb.home, ["init"]);
    const store = join(sb.home, "skill-ninja-store");
    assert.ok(existsSync(join(store, "README.md")), "first run seeds the README");
    assert.deepEqual(gitSubjects(store), ["init store"]);

    // The user edits the seed README (or git state moves on) — re-run init.
    const readme = join(store, "README.md");
    await writeFile(readme, (await readFile(readme, "utf8")) + "\nA hand-added line.\n", "utf8");
    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const after = await readFile(readme, "utf8");
    assert.match(after, /A hand-added line\./, "README not overwritten by the re-run");
    assert.deepEqual(gitSubjects(store), ["init store"], "no second init-store commit");
  } finally {
    await sb.cleanup();
  }
});

// An existing directory configured/pointed at as the store is never seeded,
// committed, or modified beyond `git init` (ADR-0016) — pointing `init` at a
// pre-existing directory must not pollute it.
test("init does not seed a store directory that already exists", async () => {
  const sb = await createSandbox({
    config: { store: "~/pre-existing-store", agents: ["claude"], vaults: [], projects: [] },
  });
  try {
    await mkdir(join(sb.home, "pre-existing-store"), { recursive: true });
    await writeFile(join(sb.home, "pre-existing-store", "notes.txt"), "hands off\n", "utf8");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const store = join(sb.home, "pre-existing-store");
    assert.ok(!existsSync(join(store, "README.md")), "an existing directory is never seeded");
    assert.equal(await readFile(join(store, "notes.txt"), "utf8"), "hands off\n", "existing files untouched");
    // `git init` on a .git-less directory is the one allowed modification.
    assert.ok(existsSync(join(store, ".git")), "git init still runs when there is no .git");
  } finally {
    await sb.cleanup();
  }
});

// `init --store <name>` (ADR-0016): a bare name (no path separators) resolves
// under $HOME, is persisted as `store`, and the store it creates is seeded
// like the default.
test("init --store <name> resolves a bare name under $HOME and persists it", async () => {
  const sb = await createSandbox({ config: null });
  try {
    await plantSkill(sb.home, ".claude/skills/boot-d");
    const { stdout, exitCode } = await runCli(sb.home, ["init", "--store", "my-skills"]);
    assert.equal(exitCode, 0, `stdout:\n${stdout}`);

    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.equal(cfg.store, join(sb.home, "my-skills"), `bare name resolved under $HOME, got:\n${cfg.store}`);
    assert.ok(existsSync(join(sb.home, "my-skills", ".git")), "store created + git init'd");
    const readme = await readFile(join(sb.home, "my-skills", "README.md"), "utf8");
    assert.match(readme, /# my-skills/, "seed README interpolates the chosen name");
    assert.deepEqual(gitSubjects(join(sb.home, "my-skills")), ["init store"]);
    // No store at the default location — the flag decided.
    assert.ok(!existsSync(join(sb.home, "skill-ninja-store")), "default location not created");
  } finally {
    await sb.cleanup();
  }
});

// `--store ~/path` and `--store /abs/path` are filesystem paths, ~-expanded or
// taken as given (ADR-0016).
test("init --store accepts a ~/… path and an absolute path", async () => {
  const tilde = await createSandbox({ config: null });
  try {
    await plantSkill(tilde.home, ".claude/skills/boot-e");
    const { stdout, exitCode } = await runCli(tilde.home, ["init", "--store", "~/code/skill-vault"]);
    assert.equal(exitCode, 0, `stdout:\n${stdout}`);
    const cfg = await readJson(join(tilde.home, ".skill-ninja", "config.json"));
    assert.equal(cfg.store, join(tilde.home, "code", "skill-vault"), `~/… expanded, got:\n${cfg.store}`);
    assert.ok(existsSync(join(tilde.home, "code", "skill-vault", "README.md")), "fresh store seeded");
  } finally {
    await tilde.cleanup();
  }

  // An absolute path stays absolute as given.
  const sb = await createSandbox({ config: null });
  try {
    await plantSkill(sb.home, ".claude/skills/boot-f");
    const abs = join(sb.home, "elsewhere", "abs-store");
    const { stdout, exitCode } = await runCli(sb.home, ["init", "--store", abs]);
    assert.equal(exitCode, 0, `stdout:\n${stdout}`);
    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.equal(cfg.store, abs, `absolute path persisted as given, got:\n${cfg.store}`);
    assert.ok(existsSync(join(abs, "README.md")), "fresh store seeded");
  } finally {
    await sb.cleanup();
  }
});

// An empty --store value (or a missing one, or any unknown argument) is a
// usage error — exit 2 (ADR-0016).
test("init --store with an empty or missing value is a usage error (exit 2)", async () => {
  const sb = await createSandbox({ config: null });
  try {
    for (const args of [["init", "--store", ""], ["init", "--store"], ["init", "--store="], ["init", "--bogus"]]) {
      const { exitCode } = await runCli(sb.home, args);
      assert.equal(exitCode, 2, `${args.join(" ")} should be a usage error`);
    }
    // Nothing was created or written by the failed runs.
    assert.ok(!existsSync(join(sb.home, ".skill-ninja", "config.json")), "no config seeded");
    assert.ok(!existsSync(join(sb.home, "skill-ninja-store")), "no store created");
  } finally {
    await sb.cleanup();
  }
});

// Pointing --store away from a previous store that still exists moves nothing:
// the old directory stays byte-for-byte and the report says so in plain
// language (ADR-0016). When the previous store does not exist, there is
// nothing to report.
test("init --store switching away reports the previous store untouched", async () => {
  const sb = await createSandbox({
    config: { store: "~/.skill-ninja/store", agents: ["claude"], vaults: [], projects: [] },
  });
  try {
    // A previous store with real content still on disk.
    await plantSkill(sb.home, ".skill-ninja/store/old-skill", { frontmatter: { name: "old-skill" } });

    const { stdout, exitCode } = await runCli(sb.home, ["init", "--store", "new-vault"]);
    assert.equal(exitCode, 0, `stdout:\n${stdout}`);

    // The config now points at the new store; the old one is untouched.
    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.equal(cfg.store, join(sb.home, "new-vault"));
    const oldSkill = join(sb.home, ".skill-ninja", "store", "old-skill", "SKILL.md");
    assert.ok(existsSync(oldSkill), "previous store content untouched");
    assert.match(stdout, /Previous store left untouched/, "plain-language switch report");
    assert.match(stdout, /\.skill-ninja\/store/, "the report names the previous path");

    // A previous store that no longer exists on disk is not reported.
    await rm(join(sb.home, "new-vault"), { recursive: true, force: true });
    const second = await runCli(sb.home, ["init", "--store", "fourth-place"]);
    assert.equal(second.exitCode, 0, `stdout:\n${second.stdout}`);
    assert.doesNotMatch(second.stdout, /Previous store left untouched/, "no note for a vanished previous store");
  } finally {
    await sb.cleanup();
  }
});

// ADR-0017: collections and profiles live store-side. init migrates
// config-side lists from a pre-v1.5 setup into the store files — once; a
// store file that already exists (e.g. it traveled with a clone) wins over
// stale local config.
test("init migrates config-side collections/profiles into the store (once)", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude"],
      vaults: [],
      projects: [],
      collections: { nils: ["aphrodite*"] },
      profiles: { content: ["alpha"] },
    },
  });
  try {
    await plantSkill(sb.home, ".claude/skills/aphrodite");
    await plantSkill(sb.home, ".skill-ninja/store/alpha", { frontmatter: { name: "alpha" } });

    const { stdout, exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0, `stdout:\n${stdout}`);
    assert.match(stdout, /Migrated collections and profiles from config\.json into the store/);

    // The lists now live store-side; the config no longer carries them.
    const collectionsFile = await readJson(join(sb.home, ".skill-ninja", "store", "collections.json"));
    assert.deepEqual(collectionsFile.nils, ["aphrodite*"]);
    const profilesFile = await readJson(join(sb.home, ".skill-ninja", "store", "profiles.json"));
    assert.deepEqual(profilesFile.content, ["alpha"]);
    const cfg = await readJson(join(sb.home, ".skill-ninja", "config.json"));
    assert.equal(cfg.collections, undefined, "config key dropped on re-seed");
    assert.equal(cfg.profiles, undefined, "config key dropped on re-seed");

    // The views resolve them from the store.
    const found = await runCli(sb.home, ["collection", "list", "nils"]);
    assert.equal(found.exitCode, 0);
    assert.match(found.stdout, /'nils' \(1 pattern/);

    // Re-running init neither duplicates nor clobbers (the files exist).
    await runCli(sb.home, ["init"]);
    const again = await readJson(join(sb.home, ".skill-ninja", "store", "collections.json"));
    assert.deepEqual(again.nils, ["aphrodite*"]);
  } finally {
    await sb.cleanup();
  }
});

// The travel story (ADR-0017): a store cloned to a fresh machine carries its
// collections and profiles; `init` on the new machine picks them up without
// any config-side data.
test("a store cloned to a fresh machine brings its collections and profiles along", async () => {
  const a = await createSandbox({ config: null });
  const b = await createSandbox({ config: null });
  try {
    // Machine A: fresh init, then a collection + a profile saved into the store.
    await plantSkill(a.home, ".claude/skills/aphrodite");
    await runCli(a.home, ["init"]);
    await plantSkill(a.home, "skill-ninja-store/aphrodite", { frontmatter: { name: "aphrodite" } });
    const savedCollection = await runCli(a.home, ["collection", "save", "nils", "aphrodite*"]);
    assert.equal(savedCollection.exitCode, 0, `stderr:\n${savedCollection.stderr}`);
    const savedProfile = await runCli(a.home, ["profile", "save", "content", "aphrodite"]);
    assert.equal(savedProfile.exitCode, 0, `stderr:\n${savedProfile.stderr}`);

    // Machine B: "clone" the store (a plain recursive copy mirrors a git
    // clone's content), then a fresh-machine init.
    await cp(join(a.home, "skill-ninja-store"), join(b.home, "skill-ninja-store"), { recursive: true });
    const init = await runCli(b.home, ["init"]);
    assert.equal(init.exitCode, 0, `stdout:\n${init.stdout}`);

    // The bundles traveled with the store — no config-side data involved.
    const list = await runCli(b.home, ["collection", "list", "nils"]);
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout, /'nils' \(1 pattern/);
    const profiles = await runCli(b.home, ["profile", "list", "content"]);
    assert.equal(profiles.exitCode, 0);
    assert.match(profiles.stdout, /'content' \(1 skill\):/);
    assert.match(profiles.stdout, /  aphrodite/);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});
