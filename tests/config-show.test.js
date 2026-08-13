// Black-box tests for the `config show` command — the minimal end-to-end path
// through skill -> CLI dispatch -> config load -> deterministic output.
// Invoked only through the CLI seam (see docs/adr/0001-node-cli-fixture-seam.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createSandbox, runCli } from "./helpers/harness.js";

test("config show prints the resolved canonical store, agent roots, and vaults", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude", "zcode"],
      vaults: ["~/Documents/Obsidian Vault"],
    },
  });
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["config", "show"]);

    assert.equal(exitCode, 0);
    // Canonical store resolved against the fake $HOME (`~` expanded).
    assert.ok(
      stdout.includes(`canonical store: ${join(sb.home, ".skill-ninja", "store")}`),
      `expected resolved store path in stdout, got:\n${stdout}`,
    );
    // Agent roots resolved via the agent-root model (tool asymmetry abstracted).
    assert.ok(
      stdout.includes(join(sb.home, ".claude", "skills")),
      `expected claude agent root in stdout, got:\n${stdout}`,
    );
    assert.ok(
      stdout.includes(join(sb.home, ".zcode", "skills")),
      `expected zcode agent root in stdout, got:\n${stdout}`,
    );
    // Vault resolved against the fake $HOME.
    assert.ok(
      stdout.includes(join(sb.home, "Documents", "Obsidian Vault")),
      `expected vault path in stdout, got:\n${stdout}`,
    );
  } finally {
    await sb.cleanup();
  }
});
