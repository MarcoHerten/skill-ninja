// Black-box tests for `ninja page` — the static HTML status page (story #41,
// ADR-0011). Like `status`, `page` reads the cached inventory written by
// `init`; each test seeds the cache the realistic way (plant a landscape, run
// `init`), runs `page`, and asserts on stdout, the written HTML file, and the
// filesystem. Tests never import engine code (ADR-0001).
//
// Slices: A) file written + path printed + self-contained; B) skills,
// locations, tags (linked spread / duplicate / content duplicate); C) version,
// provenance, tier badges; D) broken symlinks; E) regeneration on every call;
// F) nothing else on the filesystem is touched; G) escaping; H) edge cases
// (no inventory, unknown argument).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, runCli, plantSkill, plantBrokenSymlink } from "./helpers/harness.js";

function pagePath(home) {
  return join(home, ".skill-ninja", "status.html");
}

async function readPage(home) {
  return readFile(pagePath(home), "utf8");
}

// Seed the cache by running init, then run page and return its result.
async function seedAndPage(sb, pageArgs = []) {
  const init = await runCli(sb.home, ["init"]);
  assert.equal(init.exitCode, 0, `init failed while seeding; stderr:\n${init.stderr}`);
  return runCli(sb.home, ["page", ...pageArgs]);
}

// Each skill's <h3> text with inner markup stripped — the page's equivalent of
// the CLI's per-skill line ("name [tags]"), so tag composition is asserted
// exactly, not by loose substring presence.
function skillHeaders(html) {
  return [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

// Snapshot every file under a directory (path -> mtimeMs) to prove `page`
// touches nothing but its own output file.
async function snapshotTree(root) {
  const files = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(full, (await stat(full)).mtimeMs);
    }
  }
  await walk(root);
  return files;
}

// Slice A — the page lands at the default path, the command prints the path,
// and the file is self-contained: inline styles only, no scripts, no external
// assets, no http(s) references anywhere (walk-260813).
test("page writes one self-contained HTML file to ~/.skill-ninja/status.html and prints its path", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/claude-skill");
    await plantSkill(sb.home, ".zcode/skills/zcode-skill");

    const { stdout, exitCode } = await seedAndPage(sb);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.ok(
      stdout.includes(pagePath(sb.home)),
      `expected the page path in stdout, got:\n${stdout}`,
    );

    const html = await readPage(sb.home);
    assert.match(html, /^<!DOCTYPE html>/, `expected an HTML document, got:\n${html.slice(0, 200)}`);
    assert.match(html, /<style>/, `expected inline CSS, got:\n${html.slice(0, 200)}`);
    // Self-contained: no network references, no scripts, no external assets.
    assert.doesNotMatch(html, /https?:\/\//i, `no http(s) references allowed, got:\n${html}`);
    for (const tag of ["<script", "<link", "<img", "<iframe"]) {
      assert.ok(!html.includes(tag), `a self-contained page must not use ${tag}`);
    }
  } finally {
    await sb.cleanup();
  }
});

// Slice B — the page mirrors the status grouping: each skill once, with its
// locations, scan-root labels, and the same spread tags. A linked spread (one
// canonical copy + symlink into it) is [linked spread] with its resolved
// target; independent copies are [duplicate]; identical content under another
// name is [duplicate — same content, other name].
test("page shows skills, locations, scan-root labels, and the same spread tags as status", async () => {
  const sb = await createSandbox({
    config: {
      store: "~/.skill-ninja/store",
      agents: ["claude", "agents"],
      vaults: [],
      projects: [],
    },
  });
  try {
    // skills.sh pattern: real dir in the agents root, symlinked into Claude.
    const real = await plantSkill(sb.home, ".agents/skills/installed", {
      frontmatter: { name: "installed" },
      body: "# Installed body\n",
    });
    await symlink(real.dir, join(sb.home, ".claude/skills/installed"));
    // A genuine two-copy duplicate for contrast.
    await plantSkill(sb.home, ".claude/skills/shared", { body: "# Shared body\n" });
    await plantSkill(sb.home, ".agents/skills/shared", { body: "# Shared body\n" });
    // The same content under a different name (content-hash duplicate).
    await plantSkill(sb.home, ".claude/skills/alpha", { body: "# Identical instructions\n" });
    await plantSkill(sb.home, ".agents/skills/beta", { body: "# Identical instructions\n" });

    const { stdout, exitCode } = await seedAndPage(sb);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const html = await readPage(sb.home);
    const headers = skillHeaders(html);
    assert.ok(
      headers.includes("installed [linked spread]"),
      `expected the linked-spread tag on installed, got: ${JSON.stringify(headers)}`,
    );
    assert.ok(
      headers.includes("shared [duplicate]"),
      `expected the duplicate tag on shared, got: ${JSON.stringify(headers)}`,
    );
    assert.ok(
      headers.includes("alpha [duplicate — same content, other name]"),
      `expected the content-duplicate tag on alpha, got: ${JSON.stringify(headers)}`,
    );

    // Every location is shown with its scan-root label; the symlink location
    // shows its resolved target.
    assert.ok(html.includes("Claude root"), `expected the Claude scan-root label`);
    assert.ok(html.includes("agents root"), `expected the agents scan-root label`);
    assert.ok(
      html.includes(join(sb.home, ".agents", "skills", "installed")),
      `expected the installed location path`,
    );
    const resolved = await realpath(real.dir);
    assert.ok(html.includes(resolved), `expected the symlink's resolved target ${resolved}`);
    assert.ok(html.includes("→"), `expected the symlink arrow`);

    // The summary header counts only problem duplicates (linked spreads not
    // counted) — same totals as the CLI header.
    assert.ok(
      html.includes("4 skills across 6 locations, 3 duplicated skills, 0 broken symlinks."),
      `expected the summary sentence with status-identical totals`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slices C+D — version/provenance per location, Personal/External tier badges,
// and the broken-symlinks section.
test("page shows version, provenance, tier badges, and broken symlinks distinctly", async () => {
  const sb = await createSandbox();
  try {
    await writeFile(
      join(sb.home, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          "ext-skill": { source: "some/repo", sourceType: "github", computedHash: "deadbeef" },
        },
      }),
      "utf8",
    );
    await plantSkill(sb.home, ".claude/skills/ext-skill", { body: "# External body\n" });
    await plantSkill(sb.home, ".claude/skills/stamped", {
      frontmatter: {
        name: "stamped",
        version: "1.4.0",
        updated: "2026-07-01",
        provenance: { source: "authored", from: "Marco", imported: "2026-06-01", derived_from: null },
      },
      body: "# Stamped body\n",
    });
    await plantSkill(sb.home, ".claude/skills/bare", { body: "# Bare body\n" });
    const broken = await plantBrokenSymlink(sb.home, ".claude/skills/dangling-skill");

    const { stdout, exitCode } = await seedAndPage(sb);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const html = await readPage(sb.home);
    // Known version + provenance surface as plain text; absent fields read as
    // "unknown" (never raw JSON).
    assert.ok(html.includes("version: 1.4.0 (updated 2026-07-01)"), `expected the version line`);
    assert.ok(html.includes("authored, from Marco, imported 2026-06-01"), `expected the provenance summary`);
    assert.ok(html.includes("unknown"), `expected 'unknown' for the bare skill`);
    assert.ok(!html.includes('"version": null'), `no raw JSON dumps`);

    // Tier badges: skills.sh-attributed (lockfile) is External with its source;
    // authored is Personal (ADR-0004 heuristic).
    const headers = skillHeaders(html);
    assert.ok(headers.includes("ext-skill External"), `expected an External badge, got: ${JSON.stringify(headers)}`);
    assert.ok(headers.includes("stamped Personal"), `expected a Personal badge, got: ${JSON.stringify(headers)}`);
    assert.ok(html.includes("some/repo"), `expected the skills.sh source`);

    // Broken symlinks get their own section with path and scan-root label.
    assert.ok(html.includes("Broken symlinks"), `expected a broken-symlinks section`);
    assert.ok(html.includes("[broken symlink]"), `expected the broken marker`);
    assert.ok(html.includes(broken.link), `expected the broken symlink path`);
  } finally {
    await sb.cleanup();
  }
});

// The readability pass: skills render as collapsible cards — the summary
// carries name/badges plus the (CSS-clamped) description, the locations expand
// on click. Pure HTML/CSS, no scripts (ADR-0011); the full description stays
// in the markup, clamping never truncates the data.
test("page renders collapsible skill cards: clamped description in the summary, locations in the body", async () => {
  const sb = await createSandbox();
  try {
    const longDescription = "Writes LinkedIn posts. " + "Trigger words repeat and repeat ".repeat(10);
    await plantSkill(sb.home, ".claude/skills/aphrodite", {
      frontmatter: { name: "aphrodite", category: "Marketing & Social", description: longDescription },
      body: "# Aphrodite body\n",
    });
    await plantSkill(sb.home, ".claude/skills/bare", {
      frontmatter: { name: "bare", category: "Marketing & Social" },
      body: "# Bare body\n",
    });

    const { exitCode } = await seedAndPage(sb);
    assert.equal(exitCode, 0);
    const html = await readPage(sb.home);

    // Collapsible card structure — the no-script mechanism (ADR-0011).
    assert.ok(html.includes('<details class="skill">'), `expected collapsible skill cards`);
    assert.ok(html.includes("<summary>"));
    assert.ok(!html.includes("<script"));

    // The summary carries the h3 and the description, clamped by CSS only.
    assert.ok(html.includes("-webkit-line-clamp"), `expected the clamp CSS`);
    const cardIdx = html.indexOf('<details class="skill">');
    const card = html.slice(cardIdx, html.indexOf("</details>", cardIdx));
    const summary = card.slice(0, card.indexOf("</summary>"));
    assert.ok(summary.includes("<h3>aphrodite</h3>"), `expected the name inside the summary`);
    assert.ok(summary.includes('class="desc"'), `expected the description inside the summary`);
    assert.ok(
      summary.includes("Trigger words repeat"),
      `the full description stays in the markup (clamp is visual only)`,
    );

    // Locations live in the details body, after the summary.
    assert.ok(
      card.indexOf("</summary>") < card.indexOf('ul class="locations"'),
      `locations must expand inside the card`,
    );

    // A skill without a description renders no desc paragraph.
    const bareIdx = html.indexOf("<h3>bare</h3>");
    const bareCard = html.slice(bareIdx, html.indexOf("</details>", bareIdx));
    assert.ok(!bareCard.includes('class="desc"'), `no empty desc paragraph for bare`);
  } finally {
    await sb.cleanup();
  }
});

// Slice E — regeneration model: every invocation regenerates the file wholesale
// (no watcher); after a landscape change + re-init, the page shows fresh data.
test("page is regenerated on every call (overwritten with fresh inventory data)", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/first-skill", { body: "# First\n" });
    await seedAndPage(sb);
    let html = await readPage(sb.home);
    assert.ok(html.includes("first-skill"), `expected the first skill on the page`);
    assert.ok(!html.includes("second-skill"), `the second skill is not planted yet`);

    await plantSkill(sb.home, ".claude/skills/second-skill", { body: "# Second\n" });
    const { stdout, exitCode } = await seedAndPage(sb);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);
    html = await readPage(sb.home);
    assert.ok(html.includes("second-skill"), `expected the page to reflect the re-scan`);
    assert.ok(
      html.includes("2 skills across 2 locations, 0 duplicated skills, 0 broken symlinks."),
      `expected refreshed totals`,
    );
  } finally {
    await sb.cleanup();
  }
});

// Slice F — read-only towards the landscape: the ONLY filesystem change is the
// status page itself.
test("page changes nothing else on the filesystem", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/a-skill", { body: "# A\n" });
    await plantSkill(sb.home, ".zcode/skills/z-skill", { body: "# Z\n" });
    await runCli(sb.home, ["init"]);

    const before = await snapshotTree(sb.home);
    const { exitCode } = await runCli(sb.home, ["page"]);
    assert.equal(exitCode, 0);

    const after = await snapshotTree(sb.home);
    const added = [...after.keys()].filter((p) => !before.has(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));
    const changed = [...before.keys()].filter((p) => after.has(p) && after.get(p) !== before.get(p));
    assert.deepEqual(added, [pagePath(sb.home)], `only the page may be added, got: ${added}`);
    assert.deepEqual(removed, [], `nothing may be removed, got: ${removed}`);
    assert.deepEqual(changed, [], `no existing file may be touched, got: ${changed}`);
  } finally {
    await sb.cleanup();
  }
});

// Slice G — names and paths are data: they are HTML-escaped, never markup.
test("page escapes skill names and paths (no HTML injection)", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/angry", {
      frontmatter: { name: "a<b>c&d" },
      body: "# Body\n",
    });

    const { stdout, exitCode } = await seedAndPage(sb);
    assert.equal(exitCode, 0, `stderr:\n${stdout}`);

    const html = await readPage(sb.home);
    assert.ok(html.includes("a&lt;b&gt;c&amp;d"), `expected the escaped name`);
    assert.ok(!html.includes("a<b>c&d"), `the raw name must never appear as markup`);
    assert.ok(!html.includes("<script"), `no script element may be injectable`);
  } finally {
    await sb.cleanup();
  }
});

// Slice H — no cache yet: plain language, an init hint, exit 0, and no page
// written. Unknown arguments are rejected with the usage hint.
test("page with no inventory tells the user to run init first, writes nothing, exits 0", async () => {
  const sb = await createSandbox();
  try {
    const { stdout, exitCode } = await runCli(sb.home, ["page"]);

    assert.equal(exitCode, 0, `expected exit 0, stderr:\n${stdout}`);
    assert.ok(
      stdout.includes(join(sb.home, ".skill-ninja", "inventory.json")),
      `expected the missing inventory path, got:\n${stdout}`,
    );
    assert.match(stdout, /init/i, `expected an init hint, got:\n${stdout}`);
    await assert.rejects(() => readPage(sb.home), /ENOENT/, `no page may be written`);
  } finally {
    await sb.cleanup();
  }
});

test("page rejects unknown arguments with exit 2", async () => {
  const sb = await createSandbox();
  try {
    await plantSkill(sb.home, ".claude/skills/a-skill");
    await runCli(sb.home, ["init"]);
    const { stderr, exitCode } = await runCli(sb.home, ["page", "--out", "somewhere.html"]);

    assert.equal(exitCode, 2);
    assert.match(stderr, /Unknown page argument: --out/);
    assert.match(stderr, /Try: ninja page/);
  } finally {
    await sb.cleanup();
  }
});
