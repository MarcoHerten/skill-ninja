# Comparison report — template & integrity checks

Load this when `/ninja add` surfaced at least one **comparable skill** (same
family or similar purpose, different name) in the store. The outcome is a
report the user can decide on: **replace · keep parallel · merge · reject**.
(Ported from the personal `skill-intake` workflow, adapted to Skill Ninja's
model: canonical store, scan roots, provenance stamps.)

## Report structure

### 1. Classification
2–3 sentences: What is the incoming skill, where does it come from, and how does
it relate to the found existing one? (same source/framework · same domain,
different approach · relation unclear — say so openly.)

### 2. Facts table
Hard, measurable differences:

| | \<incoming skill\> | \<existing skill\> |
|---|---|---|
| Size (files / lines / words) | | |
| Structure (SKILL.md, references/, assets/, CHANGELOG) | | |
| Activation (trigger breadth of the description) | | |
| Maintenance (version / updated / provenance present?) | | |

Measure size:
```bash
find <skill-dir> -name "*.md" -exec wc -lw {} + | tail -1
```

### 3. Content comparison
Per discipline/topic: what does each have? What does the incoming one add, what
is it missing? Name concrete examples (standalone rules, templates, gates,
quality mechanisms, sample cases) — not just "more thorough" or "better". Name
the shared DNA (identical operating model, identical output formats, same
checklists); otherwise near-duplicates read like two independent drafts.

### 4. Integrity checks
For each check: finding + required resolution (see below).

### 5. Verdict & recommendation
One sentence on the incoming skill's strength, one on its weakness, then a
recommendation from {replace, keep parallel, merge, reject} with justification.
For "parallel": state which role each skill gets and how the triggers are
separated.

---

## Check 1 — Trigger collision

Two skills collide when their descriptions claim the same requests without one
deferring to the other.

**Signs:**
- both use broad always-triggers ("Activate ALWAYS when …") or similar
- same or synonymous trigger phrases and user questions in both descriptions
- no mutual delimitation ("NOT for X → \<other skill\>" missing on both sides)

**Find it:** put the descriptions of the affected skills side by side and check
for shared nouns/verbs (domain word, "audit", "optimize", "create" …). Use
`ninja status` to see all skills across the roots.

**Resolution (one suffices):**
- explicit delimitation: exactly ONE skill gets the general triggers; the other
  only "when explicitly named via \<name/variant/author\>"
- `disable-model-invocation: true` for a skill that should only ever run
  manually (comparison variants are the standard case)
- for true duplication: replace instead of keeping both

## Check 2 — Dangling references

The skill names other skills — in delimitations ("X handles that", "→ X"), as
backtick names, or in collaboration sections.

**Find it:**
```bash
grep -noE '`[a-z0-9][a-z0-9-]*`' <all .md of the skill>   # candidate names
ls -d ~/.agents/skills/<name> ~/.claude/skills/<name> ~/.zcode/skills/<name> 2>/dev/null
```
Filter out plugin-namespace references (`plugin:skill`) and generic terms in
backticks (file names, commands) — only skill references count.

**Resolution:** remove, OR point at an existing skill, OR mark as a known gap.
Never install with references into nothing — they cause mis-routing in the
agent.

## Check 3 — Variant integrity

Relevant when the incoming and the existing skill come from the same framework
or source prompt. Indicators: identical guiding principle/operating-model
formula, identical output-format structure, same reference date in the text,
same sender per provenance.

**Two questions:**

1. **Representation:** is the incoming skill meant to be a comparison variant
   (A/B) of a prompt/framework? Then it must represent its source as 1:1 as
   possible. Heavy editorial additions (own gates, templates, rules) turn every
   comparison into a two-variable experiment — source prompt AND editor share
   differ at the same time. Such a skill is a further development, not a
   variant → label it differently
   (`--relation "further development of framework <X>"` instead of
   `"A/B variant of <name>"`).
2. **Old vs. new:** provenance/version/updated must make unambiguous on both
   sides which state is older and which is used for what. Two near-identicals
   without a recorded relation invite confusion ("accidentally testing old
   against old").

**Resolution:** stamp `provenance.relation` on the incoming skill via
`ninja add --relation "…"`; extend the existing skill (only with the user's
consent) so the relationship is visible from both sides.

---

## Decision guidance

- **Replace** — the incoming one is strictly better and the existing one has no
  role of its own left (version bump; git keeps the history).
- **Keep parallel** — both have roles (A/B comparison, different modes or
  audiences); separate the triggers cleanly, record the relation.
- **Merge** — the incoming one holds single gems, the existing one the better
  base: move the additions into the better skill, retire the other, record the
  relation.
- **Reject** — inferior or duplicate; keep the library lean.
