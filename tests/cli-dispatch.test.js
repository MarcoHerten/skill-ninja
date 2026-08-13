// Black-box tests for CLI dispatch behaviour beyond the happy config path:
// graceful handling of a missing config file, unknown commands, and the
// documented-but-not-yet-wired command surface. All through the CLI seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createSandbox, runCli } from "./helpers/harness.js";

test("config show with no config file reports the absence and points to init", async () => {
  const sb = await createSandbox({ config: null });
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["config", "show"]);

    assert.equal(exitCode, 0);
    assert.ok(
      stdout.includes(join(sb.home, ".skill-ninja", "config.json")),
      `expected the missing config path in stdout, got:\n${stdout}`,
    );
    assert.ok(/init/i.test(stdout), `expected an init hint in stdout, got:\n${stdout}`);
  } finally {
    await sb.cleanup();
  }
});

test("an unknown command exits non-zero and prints usage to stderr", async () => {
  const sb = await createSandbox();
  try {
    const { stderr, exitCode } = await runCli(sb.home, ["bogus-command"]);

    assert.equal(exitCode, 2);
    assert.match(stderr, /Unknown command: bogus-command/);
    assert.match(stderr, /Usage: skill-ninja <command>/);
  } finally {
    await sb.cleanup();
  }
});

test("`doctor` is now live: with no inventory it reports the missing cache and points to init", async () => {
  const sb = await createSandbox();
  try {
    // `doctor` reads the cached inventory written by `init`. With none present
    // it says so in plain language and exits 0 — proving the command is wired
    // (it no longer reports "not implemented in this build yet").
    const { stdout, exitCode } = await runCli(sb.home, ["doctor"]);

    assert.equal(exitCode, 0);
    assert.match(stdout, /No Skill Ninja inventory found/i);
    assert.match(stdout, /init/i);
    assert.doesNotMatch(stdout, /not implemented/);
  } finally {
    await sb.cleanup();
  }
});
