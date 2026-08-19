// Black-box tests for `ninja collection` (ADR-0015) — named, personal
// filters over the cached inventory. The data lives in ~/.skill-ninja/
// config.json (never on skills, never in the product); the views resolve
// patterns live: `cat @<name>`, `find @<name>`, the page's collection filter,
// and the availability `--collection` selector. Tests import no engine code
// (ADR-0001).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { createSandbox, runCli, plantSkill } from "./helpers/harness.js";

async function readRawConfig(home) {
  return JSON.parse(await readFile(join(home, ".skill-ninja", "config.json"), "utf8"));
}

// The standard fixture: two god-named skills in one category, one bystander.
async function plantLandscape(home) {
  await plantSkill(home, ".claude/skills/aphrodite", {
    frontmatter: { name: "aphrodite", category: "Marketing & Social", description: "Writes posts." },
  });
  await plantSkill(home, ".claude/skills/aphrodite-linkedin-post", {
    frontmatter: { name: "aphrodite-linkedin-post", category: "Marketing & Social", description: "Polishes posts." },
  });
  await plantSkill(home, ".claude/skills/athena-ki-strategie", {
    frontmatter: { name: "athena-ki-strategie", category: "Strategy & Management", description: "Plans strategy." },
  });
  await plantSkill(home, ".claude/skills/docx", {
    frontmatter: { name: "docx", category: "Design & Documents", description: "Word files." },
  });
  await runCli(home, ["init"]);
}

// --- the command ---------------------------------------------------------------

test("collection save / list / forget round-trip; save warns on unmatched patterns", async () => {
  const sb = await createSandbox();
  try {
    await plantLandscape(sb.home);

    const bad = await runCli(sb.home, ["collection", "save", "a/b", "docx"]);
    assert.equal(bad.exitCode, 2);

    const saved = await runCli(sb.home, ["collection", "save", "nils", "aphrodite*", "athena-ki-strategie", "ghost-*"]);
    assert.equal(saved.exitCode, 0, `stderr:\n${saved.stderr}`);
    assert.match(saved.stdout, /Saved collection 'nils' with 3 patterns/);
    assert.match(saved.stdout, /Warning: 'ghost-\*' match no skill/);

    const raw = await readRawConfig(sb.home);
    assert.deepEqual(raw.collections.nils, ["aphrodite*", "athena-ki-strategie", "ghost-*"]);

    const list = await runCli(sb.home, ["collection", "list"]);
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout, /nils \(3 patterns, 3 matching\)/);
    assert.match(list.stdout, /cat @<name>/);

    const one = await runCli(sb.home, ["collection", "list", "nils"]);
    assert.equal(one.exitCode, 0);
    assert.match(one.stdout, /'nils' \(3 patterns, 3 matching skills?\):/);
    assert.match(one.stdout, /aphrodite\*/);
    assert.match(one.stdout, /Matching skills:/);
    assert.match(one.stdout, /aphrodite-linkedin-post/);

    const unknown = await runCli(sb.home, ["collection", "list", "nope"]);
    assert.equal(unknown.exitCode, 2);

    const empty = await createSandbox();
    try {
      const none = await runCli(empty.home, ["collection"]);
      assert.equal(none.exitCode, 0);
      assert.match(none.stdout, /no collections saved/);
    } finally {
      await empty.cleanup();
    }

    const forgot = await runCli(sb.home, ["collection", "forget", "nils"]);
    assert.equal(forgot.exitCode, 0);
    const after = await readRawConfig(sb.home);
    assert.equal(after.collections.nils, undefined);
  } finally {
    await sb.cleanup();
  }
});

test("collections survive init re-seeding (the config carry-forward)", async () => {
  const sb = await createSandbox();
  try {
    await plantLandscape(sb.home);
    await runCli(sb.home, ["collection", "save", "nils", "aphrodite*", "athena-ki-strategie"]);
    await runCli(sb.home, ["init"]);
    const raw = await readRawConfig(sb.home);
    assert.deepEqual(raw.collections.nils, ["aphrodite*", "athena-ki-strategie"]);
  } finally {
    await sb.cleanup();
  }
});

// --- the views -----------------------------------------------------------------

test("cat @<name> shows only the members, still grouped under their content categories", async () => {
  const sb = await createSandbox();
  try {
    await plantLandscape(sb.home);
    await runCli(sb.home, ["collection", "save", "nils", "aphrodite*", "athena-ki-strategie"]);

    const view = await runCli(sb.home, ["cat", "@nils"]);
    assert.equal(view.exitCode, 0, `stderr:\n${view.stderr}`);
    assert.match(view.stdout, /\(collection: nils — 3 skills\)/);
    assert.match(view.stdout, /Marketing & Social \(2\):/);
    assert.match(view.stdout, /Strategy & Management \(1\):/);
    assert.match(view.stdout, /  aphrodite — Writes posts\./);
    assert.doesNotMatch(view.stdout, /docx/);

    // The full catalog advertises the configured collection.
    const full = await runCli(sb.home, ["cat"]);
    assert.match(full.stdout, /collections configured: nils/);

    const unknown = await runCli(sb.home, ["cat", "@nope"]);
    assert.equal(unknown.exitCode, 0);
    assert.match(unknown.stdout, /No collection 'nope'\. Collections present: nils\./);
  } finally {
    await sb.cleanup();
  }
});

test("find @<name> lists the bundle flat with tags; page carries data-collections + dropdown", async () => {
  const sb = await createSandbox();
  try {
    await plantLandscape(sb.home);
    await runCli(sb.home, ["collection", "save", "nils", "aphrodite*", "athena-ki-strategie"]);

    const found = await runCli(sb.home, ["find", "@nils"]);
    assert.equal(found.exitCode, 0);
    assert.match(found.stdout, /Skill Ninja find — @nils/);
    assert.match(found.stdout, /3 matches:/);
    assert.match(found.stdout, /  aphrodite — Writes posts\./);
    assert.doesNotMatch(found.stdout, /docx/);

    const unknown = await runCli(sb.home, ["find", "@nope"]);
    assert.equal(unknown.exitCode, 0);
    assert.match(unknown.stdout, /No collection 'nope'\./);

    // The page: membership is computed server-side (data-collections on the
    // card), the cockpit gets a collection dropdown.
    const page = await runCli(sb.home, ["page"]);
    assert.equal(page.exitCode, 0);
    const html = await readFile(join(sb.home, ".skill-ninja", "status.html"), "utf8");
    const cardFor = (name) => {
      const open = `<details class="skill" data-name="${name}"`;
      const start = html.indexOf(open);
      assert.ok(start !== -1, `the ${name} card exists`);
      return html.slice(start, html.indexOf("</details>", start));
    };
    assert.ok(
      cardFor("aphrodite").includes('data-collections="nils"'),
      `the aphrodite card carries data-collections="nils"`,
    );
    assert.ok(
      cardFor("docx").includes('data-collections=""'),
      `docx is in no collection`,
    );
    assert.ok(html.includes('id="f-col"'), `the collection dropdown exists`);
    assert.ok(html.includes('<option value="nils">@nils</option>'), `the dropdown lists the collection`);
  } finally {
    await sb.cleanup();
  }
});

test("on/off/manual accept --collection; an unknown collection is a strict error", async () => {
  const sb = await createSandbox();
  try {
    // Switchable skills need stored copies + links (the availability guard
    // refuses loose ones — that rule is tested in availability.test.js).
    for (const [name, category] of [
      ["aphrodite", "Marketing & Social"],
      ["aphrodite-linkedin-post", "Marketing & Social"],
      ["athena-ki-strategie", "Strategy & Management"],
    ]) {
      const stored = await plantSkill(sb.home, `.skill-ninja/store/${name}`, {
        frontmatter: { name, category },
      });
      await symlink(stored.dir, join(sb.home, ".claude/skills", name));
    }
    await plantSkill(sb.home, ".claude/skills/docx", { frontmatter: { name: "docx" } });
    await runCli(sb.home, ["init"]);
    await runCli(sb.home, ["collection", "save", "nils", "aphrodite*", "athena-ki-strategie"]);

    const dry = await runCli(sb.home, ["off", "--collection", "nils"]);
    assert.equal(dry.exitCode, 0, `stderr:\n${dry.stderr}`);
    assert.match(dry.stdout, /dry run \(3 skills selected\)/);
    assert.match(dry.stdout, /aphrodite \[active → off\]/);
    assert.doesNotMatch(dry.stdout, /docx/);

    const unknown = await runCli(sb.home, ["off", "--collection", "nope", "--apply"]);
    assert.equal(unknown.exitCode, 2);
    assert.match(unknown.stderr, /No collection 'nope'\. Collections present: nils\./);
  } finally {
    await sb.cleanup();
  }
});

test("patterns are exact names or prefix globs, matched case-insensitively", async () => {
  const sb = await createSandbox();
  try {
    await plantLandscape(sb.home);
    // Glob catches both aphrodite variants; an exact name catches only itself.
    await runCli(sb.home, ["collection", "save", "a", "APHRODITE*"]);
    await runCli(sb.home, ["collection", "save", "b", "docx"]);

    const a = await runCli(sb.home, ["find", "@a"]);
    assert.match(a.stdout, /2 matches:/);
    const b = await runCli(sb.home, ["find", "@b"]);
    assert.match(b.stdout, /1 match:/);
    assert.match(b.stdout, /docx/);
  } finally {
    await sb.cleanup();
  }
});
