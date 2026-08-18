// Black-box tests for skills.sh lockfile attribution (ADR-0007/0008). skills.sh
// records the External skills it owns in skills-lock.json (`source`, `sourceType`,
// `computedHash`). When `init` scans, it reads the lockfile and tags matching
// occurrences External, so `status` can distinguish skills.sh-owned skills from
// Personal ones. The global lockfile lives at ~/skills-lock.json and covers every
// agent root; a per-root lockfile covers vault/project roots.
// (ADR-0001 seam.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readInventory(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "inventory.json"), "utf8"));
}

// A skill named in the global lockfile is tagged External with its skills.sh
// source; a sibling not in the lockfile stays unattributed.
test("init tags skills.sh-installed skills External via the global skills-lock.json", async () => {
  const sb = await createSandbox();
  try {
    // The global lockfile skills.sh writes at $HOME.
    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify(
        {
          version: 1,
          skills: {
            "ext-skill": {
              source: "some/repo",
              sourceType: "github",
              skillPath: "skills/x/ext-skill/SKILL.md",
              computedHash: "deadbeef",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await plantSkill(sb.home, ".claude/skills/ext-skill"); // no provenance — attribution comes from the lockfile
    await plantSkill(sb.home, ".claude/skills/personal-skill"); // NOT in the lockfile

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const byName = Object.fromEntries(cache.skills.map((s) => [s.name, s]));

    assert.equal(byName["ext-skill"].tier, "external", `expected external tier, got:\n${JSON.stringify(byName["ext-skill"])}`);
    assert.deepEqual(
      byName["ext-skill"].external,
      { source: "some/repo", computedHash: "deadbeef" },
      `expected skills.sh attribution, got:\n${JSON.stringify(byName["ext-skill"].external)}`,
    );

    // The non-locked skill is unattributed.
    assert.equal(byName["personal-skill"].tier, null);
    assert.equal(byName["personal-skill"].external, null);

    // status surfaces the external attribution in plain language.
    const { stdout } = await runCli(sb.home, ["status"]);
    assert.match(stdout, /external/, `expected an 'external' attribution in status, got:\n${stdout}`);
    assert.ok(stdout.includes("some/repo"), `expected the skills.sh source in status, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

// An agent root may carry its OWN skills-lock.json (skills.sh writes the file
// per install scope). Its entries are merged over the global lockfile for that
// root — per-root precedence — so a skill the global lockfile doesn't know is
// still attributed External.
test("init attributes agent-root skills via a per-root skills-lock.json, overriding the global one", async () => {
  const sb = await createSandbox();
  try {
    // Global lockfile knows only the clerk skill.
    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          clerk: { source: "clerk/skills", sourceType: "github", computedHash: "aaaa" },
        },
      }),
      "utf8",
    );
    // The Claude root's own lockfile knows two more — including a different
    // source for `clerk`, which must win for that root.
    await writeFile(
      join(sb.home, ".claude", "skills", "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          "root-lock-skill": { source: "org/other-repo", sourceType: "github", computedHash: "bbbb" },
          clerk: { source: "clerk/skills-fork", sourceType: "github", computedHash: "cccc" },
        },
      }),
      "utf8",
    );
    await plantSkill(sb.home, ".claude/skills/clerk");
    await plantSkill(sb.home, ".claude/skills/root-lock-skill");
    // Same name in the ZCode root: only the GLOBAL lockfile applies there.
    await plantSkill(sb.home, ".zcode/skills/clerk");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const byNameAndRoot = new Map(
      cache.skills.map((s) => [`${s.name}@${s.scanRoot.ref}`, s]),
    );
    assert.equal(
      byNameAndRoot.get("root-lock-skill@claude")?.tier,
      "external",
      `expected the per-root-only skill to be attributed External, got:\n${JSON.stringify(cache.skills)}`,
    );
    assert.equal(byNameAndRoot.get("root-lock-skill@claude")?.external?.source, "org/other-repo");
    // Per-root precedence in the Claude root …
    assert.equal(byNameAndRoot.get("clerk@claude")?.external?.source, "clerk/skills-fork");
    // … while the ZCode root still resolves through the global lockfile.
    assert.equal(byNameAndRoot.get("clerk@zcode")?.external?.source, "clerk/skills");
  } finally {
    await sb.cleanup();
  }
});

// A project scan root with its own skills-lock.json attributes the skills it owns
// (project-scoped lockfile, not the global one).
test("init attributes project-root skills via a per-root skills-lock.json", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: [],
      vaults: [],
      projects: ["~/code/myapp"],
    },
  });
  try {
    await writeFile(
      join(sb.home, "code", "myapp", "skills-lock.json"),
      JSON.stringify(
        {
          version: 1,
          skills: {
            "proj-skill": {
              source: "org/proj-skills",
              sourceType: "github",
              skillPath: "skills/proj-skill/SKILL.md",
              computedHash: "cafebabe",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await plantSkill(sb.home, "code/myapp/.claude/skills/proj-skill");

    const { exitCode } = await runCli(sb.home, ["init"]);
    assert.equal(exitCode, 0);

    const cache = await readInventory(sb.home);
    const found = cache.skills.find((s) => s.name === "proj-skill");
    assert.ok(found, `expected proj-skill, got:\n${JSON.stringify(cache.skills)}`);
    assert.equal(found.tier, "external");
    assert.equal(found.external.source, "org/proj-skills");
  } finally {
    await sb.cleanup();
  }
});
