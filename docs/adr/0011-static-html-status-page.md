# Static HTML status page

User story #41 (SPEC.md): "I want a status page to view my skill landscape in a
browser as a static HTML page." `ninja status` is a terminal report; the browser
view must not turn Skill Ninja into a web service — the product is local-first,
agent-native, and aimed at non-experts (SPEC.md "Out of Scope": no cloud
hosting, no GUI application).

## Decision

`ninja page` renders the **cached inventory** (ADR-0003, schema v2 — it does
**not** re-scan) into **one self-contained static HTML file** and prints its
path.

- **Output.** `~/.skill-ninja/status.html`. Self-contained means: inline CSS in
  a `<style>` block, no scripts, no external assets or fonts, no network — the
  file opens via `file://` and works offline (requirement source:
  walk-260813). Regenerated wholesale on every invocation; no watcher, no
  server, no auto-refresh.
- **Content.** The HTML counterpart of `ninja status`: per Skill the name, each
  location with its scan-root label, `symlink → resolved target`,
  `version`/provenance per location, a Personal/External tier badge, and the
  same tags — `[linked spread]` / `[duplicate]` /
  `[duplicate — same content, other name]` — plus a broken-symlinks section and
  a summary header with the same totals.
- **One implementation of the grouping.** `page` imports the grouping/tagging
  logic from `engine/status.js` (`groupSkills`, `isPersonal`, `versionLine`,
  labels, summaries). The page and the CLI report cannot diverge — there is no
  second copy of the linked-spread/duplicate/personal rules to keep in sync.
- **Separate command, not `status --html`.** `status` flags are data *filters*
  (`--broken` / `--duplicates` / `--personal`, AND semantics) over one output
  medium; an output-medium switch is a different axis. A dedicated `page`
  command keeps both parsers trivial and the slash-command table honest.
- **Read-only, one file.** `page` writes exactly `status.html` and touches
  nothing else on the filesystem; no dependencies beyond Plain Node.

## Considered Options

- **GitHub Pages variant** (publish the landscape/store to a Pages site) —
  rejected: violates local-first (personal skill names, absolute paths, and
  provenance would leave the machine; network + CI plumbing where none is
  needed), and the page must work offline for non-experts. Opening a local file
  is the whole delivery mechanism.
- **A live server / watcher** (auto-refresh on landscape change) — rejected: a
  background process contradicts the computed-on-demand model (SPEC.md
  "No anti-patterns") and adds state to keep alive. Regenerating is one cheap
  command; `init` owns scanning, so a watcher would re-scan behind `init`'s
  back.
- **`status --html`** — rejected: see Decision (filter axis vs. medium axis).
- **Rendering from a live scan instead of the cache** — rejected: `status` and
  `doctor` read the cached inventory (ADR-0003); `page` follows the same
  contract, so all three views agree by construction.

## Consequences

- The page shows the inventory snapshot, not the live landscape; its header
  carries the `generatedAt` timestamp. Refresh = `ninja init` + `ninja page`.
- The page contains landscape metadata (names, absolute paths, provenance);
  treat `status.html` as local, private data. Skill Ninja never publishes or
  pushes it.
- Data-derived text (e.g. a `provenance.from` or skills.sh `source` that is a
  URL) may appear as **plain text**; the page itself references no external
  resources and loads none. All interpolated values are HTML-escaped — names
  and paths are data, never markup.
- `status.js` gains small exports (`groupSkills`, `isPersonal`, `versionLine`,
  `plural`) that `page.js` consumes — the grouping rules keep exactly one home.

## Update (2026-08-18 — availability cockpit, ADR-0014)

The "no scripts" clause is relaxed to: **no network, no external assets, no
server** — inline vanilla JavaScript is allowed. The page gained the
availability layer's selection cockpit: a search box, availability / tier /
category filters, a checkbox per skill, and a generated read-only
`ninja on|manual|off --apply …` command line to copy and run. The page itself
still executes nothing and writes nothing — it remains one self-contained
static file, regenerated wholesale by `ninja page`, opening offline via
`file://`; the script only filters DOM nodes the server-side render produced
and strings together a command from their data attributes. Bulk execution
stays in the engine behind `--apply`, preserving the two-phase approval
model (the copy-command is the proposal, the CLI run with `--apply` the
approval).
## Update (2026-08-19 — per-skill copy-to-chat button, story #54)

Each card now carries a small `copy` button **directly behind the skill
name**: one click puts the skill's **full SKILL.md** (frontmatter + body) on
the clipboard, ready to paste into any LLM chat (Claude, ChatGPT, Gemini, …).
Using a skill should not require the agent that hosts it — the page's most
wanted export is the skill itself.

- **Payload embedded server-side.** The SKILL.md text is read best-effort at
  `ninja page` render time from each group's first occurrence (first-scanned
  wins, the rule category/description follow; linked spreads and duplicates
  share one file) and embedded into the card as a hidden, escaped `<pre>`.
  The inventory cache stays lean — it records the content hash, not the
  content (ADR-0003 unchanged). A file that vanished since `init` renders no
  button and no payload; `page` still writes exactly `status.html` — reading
  the bodies is the one landscape read the command allows itself.
- **Script behavior unchanged in kind.** The cockpit hands the payload's
  `textContent` to the clipboard API (with an `execCommand` fallback for
  engines without it) and cancels the `<summary>` toggle on button clicks —
  the same event-cancellation problem the pick checkbox solves. No network,
  no file access from the browser, no execution: still one self-contained
  offline `file://` page.
- **Escaping and data.** Bodies are data like names and paths: markup inside
  a SKILL.md arrives escaped and can never inject elements. A body may
  contain URLs — they are inert text, the page loads none of them.
- **Size tradeoff.** The page grows by the embedded bodies (a few KB per
  skill; ~0.9 MB → ~5.7 MB on the 412-skill reference machine). Accepted:
  the alternative (fetching files from the browser) is blocked on `file://`
  and would break the offline guarantee.
- **Search scope.** The cockpit's search haystack excludes the payload —
  searching stays name/description/category/locations, not full-text body
  search (the payload would make almost every term match almost every
  skill).

## Update (2026-08-19, later the same day — the copy button copies the NAME)

Owner feedback on the shipped button: pasting the full SKILL.md puts a wall
of text on the clipboard — what is actually wanted is the skill's **name**,
the token you paste into a chat or terminal to invoke the skill. Story #54
is revised accordingly: one click behind the name copies the name, and the
full-file export above is withdrawn — the dump buried the one token wanted
on the clipboard (the name) in a wall of text.

- **Payload embedding removed.** The name comes from the card's
  `data-name` attribute (cache data), so the button renders from the
  snapshot alone and `page` reads NOTHING from the landscape again — the
  strict read-only property of the original decision is fully restored. A
  SKILL.md deleted since `init` no longer drops its card's button.
- **Size tradeoff void.** Without the embedded bodies the page shrinks back
  to name/description/locations markup (~0.9 MB on the 412-skill reference
  machine; the ~5.7 MB figure above is obsolete).
- **Script behavior unchanged in kind.** The cockpit hands the name to the
  clipboard API (with the `execCommand` fallback) and still cancels the
  `<summary>` toggle on button clicks. Search stays
  name/description/category/locations — now trivially, because bodies are
  simply not on the page.

