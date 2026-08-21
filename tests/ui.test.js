// Black-box tests for `ninja ui` — the Manager UI server (ADR-0019). Like the
// other command tests they go through the CLI seam against a sandboxed fake
// $HOME; because `ui` runs a foreground server that never exits, the harness
// here spawns it with `--port 0 --no-open`, reads the printed URL off stdout,
// talks HTTP to the loopback server, and kills the child at the end. Tests
// assert on HTTP responses and the resulting filesystem — never engine
// internals (ADR-0001).
//
// Slices: A) server start + page served; B) /api/state (groups, tiers,
// availability, notes, profiles); C) /api/exec dry-run/apply (two-phase
// approval: the endpoint is the CLI, nothing else); D) /api/note (write,
// clear, commit in a git store); E) skill payloads raw + Chat-Prompt; F)
// /api/external-remove ownership guard (no npx spawn in tests); G) routing
// errors (allowlist, 404, bad bodies).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { createSandbox, runCli, plantSkill, ENGINE_PATH, storePath, makeStoreGitRepo } from "./helpers/harness.js";

// Spawn `ninja ui` on an ephemeral port, wait for the printed URL, return a
// client (fetch + kill). The URL line is the first stdout chunk ending in a
// printable URL.
async function startUi(home) {
  const child = spawn(process.execPath, [ENGINE_PATH, "ui", "--port", "0", "--no-open"], {
    env: { ...process.env, HOME: home },
  });
  let stdout = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ui did not report a URL; stdout so far:\n${stdout}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`ui exited early (${code}); output:\n${stdout}`));
    });
  });
  return {
    url,
    async req(path, opts) {
      const res = await fetch(url + path, opts);
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {} // HTML stays a string
      return { status: res.status, body };
    },
    post(path, payload) {
      return this.req(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    stop() {
      child.kill("SIGKILL");
      return new Promise((resolve) => child.on("close", resolve));
    },
  };
}

// Seed a store-side personal skill: stored copy + links in the agent roots
// (the shape `add` produces), via the engine itself where possible.
async function seedPersonal(home, name) {
  const stored = join(storePath(home), name);
  await mkdir(stored, { recursive: true });
  await writeFile(
    join(stored, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\nprovenance:\n  source: authored\n---\n\n# ${name}\n\nBody line.\n`,
    "utf8",
  );
  for (const root of [join(home, ".claude", "skills"), join(home, ".zcode", "skills")]) {
    await mkdir(root, { recursive: true });
    await symlink(stored, join(root, name));
  }
}

test("ui serves the Manager UI page and reports a loopback URL", async () => {
  const sb = await createSandbox();
  const ui = await startUi(sb.home);
  try {
    const { status, body } = await ui.req("/");
    assert.equal(status, 200);
    assert.match(body, /^<!DOCTYPE html>/);
    assert.match(body, /Skill Ninja Manager/);
    // Self-contained page: no external assets or network references.
    assert.doesNotMatch(body, /https?:\/\/(?!127\.0\.0\.1)/);
    assert.doesNotMatch(body, /<link\b/i);
  } finally {
    await ui.stop();
    await sb.cleanup();
  }
});

test("ui with no inventory serves a not-ready state that says so", async () => {
  const sb = await createSandbox();
  const ui = await startUi(sb.home);
  try {
    const { status, body } = await ui.req("/api/state");
    assert.equal(status, 200);
    assert.equal(body.ready, false);
    assert.equal(body.reason, "no-inventory");
  } finally {
    await ui.stop();
    await sb.cleanup();
  }
});

test("/api/state groups skills with tier, availability, locations, notes, and profiles", async () => {
  const sb = await createSandbox();
  try {
    await seedPersonal(sb.home, "own-skill");
    await plantSkill(sb.home, ".codex/skills/codex-skill", { frontmatter: { name: "codex-skill" } });
    await plantSkill(sb.home, ".claude/skills/ninja", { frontmatter: { name: "ninja" } });
    // A store-side profile to travel with the state.
    await writeFile(join(storePath(sb.home), "profiles.json"), JSON.stringify({ marketing: ["own-skill"] }, null, 2) + "\n", "utf8");

    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      const { status, body } = await ui.req("/api/state");
      assert.equal(status, 200);
      assert.equal(body.ready, true);
      assert.ok(body.generatedAt, "expected the inventory timestamp");
      assert.deepEqual(body.profiles, { marketing: ["own-skill"] });

      const byName = new Map(body.groups.map((g) => [g.name, g]));
      const own = byName.get("own-skill");
      assert.equal(own.tier, "personal");
      assert.equal(own.availability, "active");
      assert.equal(own.description, "Test skill own-skill");
      assert.equal(own.note, "");
      assert.ok(own.locations.length >= 1, "expected at least the store location");

      // ninja itself is part of the landscape but never switchable — the
      // state carries it like any other group; the guard lives in the engine.
      assert.ok(byName.has("ninja"));
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("/api/exec runs the engine two-phase: dry-run plan, then --apply stamps the store", async () => {
  const sb = await createSandbox();
  try {
    await seedPersonal(sb.home, "own-skill");
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      const dry = await ui.post("/api/exec", { argv: ["manual", "own-skill"] });
      assert.equal(dry.status, 200);
      assert.equal(dry.body.code, 0);
      assert.match(dry.body.stdout, /dry run/);
      // Dry-run wrote nothing: the stored copy is unstamped.
      const stored = await readFile(join(storePath(sb.home), "own-skill", "SKILL.md"), "utf8");
      assert.doesNotMatch(stored, /availability:/);

      const app = await ui.post("/api/exec", { argv: ["manual", "own-skill", "--apply"] });
      assert.equal(app.body.code, 0);
      assert.match(app.body.stdout, /applied/);
      const stamped = await readFile(join(storePath(sb.home), "own-skill", "SKILL.md"), "utf8");
      assert.match(stamped, /availability: "?manual"?/);
      assert.match(stamped, /disable-model-invocation: true/);
      assert.match(stamped, /activation_text:/);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("/api/exec rejects commands outside the Manager UI surface", async () => {
  const sb = await createSandbox();
  const ui = await startUi(sb.home);
  try {
    const res = await ui.post("/api/exec", { argv: ["add", "something"] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not part of the Manager UI surface/);
    const res2 = await ui.post("/api/exec", { argv: [] });
    assert.equal(res2.status, 400);
  } finally {
    await ui.stop();
    await sb.cleanup();
  }
});

test("/api/note writes a Note beside the stored copy, commits it in a git store, and clears it", async () => {
  const sb = await createSandbox();
  try {
    await seedPersonal(sb.home, "own-skill");
    makeStoreGitRepo(sb.home);
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      const saved = await ui.post("/api/note", { name: "own-skill", text: "Relevant für Marketing-Set" });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.committed, true);

      const notePath = join(storePath(sb.home), "own-skill", "NOTE.md");
      assert.equal(await readFile(notePath, "utf8"), "Relevant für Marketing-Set\n");

      // The state reflects it.
      const state = await ui.req("/api/state");
      const own = state.body.groups.find((g) => g.name === "own-skill");
      assert.equal(own.note, "Relevant für Marketing-Set\n");

      // Blank text deletes the Note.
      const cleared = await ui.post("/api/note", { name: "own-skill", text: "  " });
      assert.equal(cleared.body.deleted, true);
      await assert.rejects(readFile(notePath), /ENOENT/);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("/api/note refuses names without a stored copy", async () => {
  const sb = await createSandbox();
  try {
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      const res = await ui.post("/api/note", { name: "ghost", text: "x" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /No stored skill 'ghost'/);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("skill payloads: raw serves the full SKILL.md, prompt wraps body + task placeholder + asset warning", async () => {
  const sb = await createSandbox();
  try {
    await seedPersonal(sb.home, "own-skill");
    // A bundled asset beside the SKILL.md — the Chat-Prompt must warn.
    await writeFile(join(storePath(sb.home), "own-skill", "references.md"), "# Extra\n", "utf8");
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      const raw = await ui.req("/api/skill/own-skill/raw");
      assert.equal(raw.status, 200);
      assert.match(raw.body.text, /^---\n/);
      assert.match(raw.body.text, /Body line\./);
      assert.deepEqual(raw.body.assets, ["references.md"]);

      const prompt = await ui.req("/api/skill/own-skill/prompt");
      assert.equal(prompt.status, 200);
      const text = prompt.body.text;
      // Frontmatter stays out; the body and the framing travel.
      assert.doesNotMatch(text, /^---\n/);
      assert.doesNotMatch(text, /provenance:/);
      assert.match(text, /SKILL-ANLEITUNG: own-skill/);
      assert.match(text, /Zweck: Test skill own-skill/);
      assert.match(text, /Body line\./);
      assert.match(text, /Aufgabe:\s*$/);
      assert.match(text, /references\.md/);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("skill payloads 404 for unknown names and traversal attempts", async () => {
  const sb = await createSandbox();
  try {
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      assert.equal((await ui.req("/api/skill/ghost/raw")).status, 404);
      // A %2F in the segment decodes to a slash — rejected as a name, not
      // treated as a path.
      const bad = await ui.req("/api/skill/..%2Fetc/raw");
      assert.equal(bad.status, 400);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("/api/external-remove only accepts skills.sh-owned skills (delegation guard, ADR-0020)", async () => {
  const sb = await createSandbox();
  try {
    await seedPersonal(sb.home, "own-skill");
    await runCli(sb.home, ["init"]);
    const ui = await startUi(sb.home);
    try {
      // A personal skill is refused — no npx is ever spawned for it.
      const res = await ui.post("/api/external-remove", { name: "own-skill", scope: "global" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /not an External \(skills\.sh\) skill/);

      const ghost = await ui.post("/api/external-remove", { name: "ghost", scope: "global" });
      assert.equal(ghost.status, 404);

      const badScope = await ui.post("/api/external-remove", { name: "own-skill", scope: "everywhere" });
      assert.equal(badScope.status, 400);
      const noDir = await ui.post("/api/external-remove", { name: "own-skill", scope: "project" });
      assert.equal(noDir.status, 400);
    } finally {
      await ui.stop();
    }
  } finally {
    await sb.cleanup();
  }
});

test("routing: unknown paths 404, malformed JSON 400, non-POST on actions 404", async () => {
  const sb = await createSandbox();
  const ui = await startUi(sb.home);
  try {
    assert.equal((await ui.req("/api/nope")).status, 404);

    const res = await fetch(ui.url + "/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);

    assert.equal((await ui.req("/api/exec")).status, 404); // GET on a POST route
  } finally {
    await ui.stop();
    await sb.cleanup();
  }
});

test("`ninja ui` argument surface: unknown flags and bad ports exit 2 without listening", async () => {
  const sb = await createSandbox();
  try {
    const bad = await runCli(sb.home, ["ui", "--bogus"]);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /unknown ui argument/);

    const port = await runCli(sb.home, ["ui", "--port", "not-a-number"]);
    assert.equal(port.exitCode, 2);
    assert.match(port.stderr, /--port needs a number/);
  } finally {
    await sb.cleanup();
  }
});
