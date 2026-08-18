// Black-box tests for `ninja profile` (ADR-0014) — named, reusable skill sets
// applied per project via project-local symlinks. save/forget manage the
// config data; apply runs in the project directory and links members into
// <cwd>/.agents/skills → <store>; lift removes exactly those links. Tests
// import no engine code (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandbox, runCli, plantSkill, readStoredSkill } from "./helpers/harness.js";

async function readRawConfig(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "config.json"), "utf8"));
}

async function makeProjectDir() {
  return mkdtemp(join(tmpdir(), "ninja-project-"));
}

test("profile save validates members against the store; list shows what exists", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".skill-ninja/store/alpha", { frontmatter: { name: "alpha" } });
    await plantSkill(sb.home, ".skill-ninja/store/beta", { frontmatter: { name: "beta" } });

    const bad = await runCli(sb.home, ["profile", "save", "content", "alpha", "nope"]);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /No stored skill 'nope'/);

    const ok = await runCli(sb.home, ["profile", "save", "content", "alpha", "beta"]);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /Saved profile 'content' with 2 skills/);

    const raw = await readRawConfig(sb.home);
    assert.deepEqual(raw.profiles.content, ["alpha", "beta"]);

    const list = await runCli(sb.home, ["profile", "list"]);
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout, /content \(2 skills\)/);

    const one = await runCli(sb.home, ["profile", "list", "content"]);
    assert.equal(one.exitCode, 0);
    assert.match(one.stdout, /'content' \(2 skills\):/);
    assert.match(one.stdout, /  alpha/);

    const none = await runCli(sb.home, ["profile", "list", "missing"]);
    assert.equal(none.exitCode, 2);

    // An empty landscape lists a hint instead of nothing.
    const sb2 = await createSandbox();
    try {
      const empty = await runCli(sb2.home, ["profile"]);
      assert.equal(empty.exitCode, 0);
      assert.match(empty.stdout, /no profiles saved/);
    } finally {
      await sb2.cleanup();
    }
  } finally {
    await sb.cleanup();
  }
});

test("profile apply links members into <project>/.agents/skills and is idempotent", async () => {
  const sb = await createSandbox();
  const project = await makeProjectDir();
  try {
    await plantSkill(sb.home, ".skill-ninja/store/alpha", { frontmatter: { name: "alpha" } });
    await plantSkill(sb.home, ".skill-ninja/store/beta", { frontmatter: { name: "beta" } });
    await runCli(sb.home, ["profile", "save", "content", "alpha", "beta"]);

    const { stdout, exitCode } = await runCli(sb.home, ["profile", "apply", "content"], { cwd: project });
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    // process.cwd() resolves through macOS's /tmp symlink — compare realpaths.
    const projectReal = await realpath(project);
    assert.match(stdout, new RegExp(`Applied profile 'content' in ${projectReal}`));

    for (const name of ["alpha", "beta"]) {
      const link = join(project, ".agents", "skills", name);
      assert.ok(existsSync(link), `${name} linked`);
      const resolved = await realpath(link);
      assert.equal(resolved, await realpath(join(sb.home, ".skill-ninja/store", name)));
    }

    // Re-apply is a no-op-ish refresh (links replaced, still correct).
    const again = await runCli(sb.home, ["profile", "apply", "content"], { cwd: project });
    assert.equal(again.exitCode, 0);
    assert.ok(existsSync(join(project, ".agents/skills/alpha")));
  } finally {
    await sb.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("profile apply never replaces a real directory (data-loss guard)", async () => {
  const sb = await createSandbox();
  const project = await makeProjectDir();
  try {
    await plantSkill(sb.home, ".skill-ninja/store/alpha", { frontmatter: { name: "alpha" } });
    await runCli(sb.home, ["profile", "save", "content", "alpha"]);

    // A real local skill dir at the link target.
    await mkdir(join(project, ".agents/skills/alpha"), { recursive: true });
    await writeFile(join(project, ".agents/skills/alpha/SKILL.md"), "---\nname: alpha\n---\n\n# Local\n", "utf8");

    const { stdout, exitCode } = await runCli(sb.home, ["profile", "apply", "content"], { cwd: project });
    assert.equal(exitCode, 0);
    assert.match(stdout, /skipped alpha — a real directory exists/);

    const st = await stat(join(project, ".agents/skills/alpha"));
    assert.ok(st.isDirectory(), "the real directory survives");
    const text = await readFile(join(project, ".agents/skills/alpha/SKILL.md"), "utf8");
    assert.ok(text.includes("# Local"), "the local content survives");
  } finally {
    await sb.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("profile lift removes only store-pointing links; forget removes the profile", async () => {
  const sb = await createSandbox();
  const project = await makeProjectDir();
  try {
    await plantSkill(sb.home, ".skill-ninja/store/alpha", { frontmatter: { name: "alpha" } });
    await runCli(sb.home, ["profile", "save", "content", "alpha"]);
    await runCli(sb.home, ["profile", "apply", "content"], { cwd: project });

    // A foreign link (points elsewhere) and a real dir must survive lift.
    await mkdir(join(project, "elsewhere"), { recursive: true });
    await symlink(join(project, "elsewhere"), join(project, ".agents/skills/foreign"));

    const { stdout, exitCode } = await runCli(sb.home, ["profile", "lift", "content"], { cwd: project });
    assert.equal(exitCode, 0);
    assert.ok(!existsSync(join(project, ".agents/skills/alpha")), "our link is lifted");
    assert.ok(existsSync(join(project, ".agents/skills/foreign")), "a foreign link is untouched");

    const forget = await runCli(sb.home, ["profile", "forget", "content"]);
    assert.equal(forget.exitCode, 0);
    assert.match(forget.stdout, /Forgot profile 'content'/);
    const raw = await readRawConfig(sb.home);
    assert.equal(raw.profiles.content, undefined);

    const gone = await runCli(sb.home, ["profile", "apply", "content"], { cwd: project });
    assert.equal(gone.exitCode, 2);
    assert.match(gone.stderr, /No profile 'content'/);
  } finally {
    await sb.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});
