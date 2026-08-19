# Collections are config-side personal filters, not stamps

Bundling skills for display and bulk selection ("everything from Nils", "the
god-name family") is a *personal* view need. ADR-0013's headline philosophy is
"categories are data on the skill, never a mapping in a script" — and the
obvious mirror of that would be an owner/grouping **stamp** on the stored copy,
versioned in the store's git repo like every other stamp.

## Decision

**Collections live in `~/.skill-ninja/config.json`, not on skills.** A
collection is a name plus a list of patterns (exact names or `prefix*` globs,
matched case-insensitively); the views resolve them live against the cached
inventory (`cat @<name>`, `find @<name>`, the page's collection filter) and the
availability selectors accept `--collection <name>`. `ninja collection save |
list | forget` manages them; `init`'s re-seeding carries them forward like
`profiles`.

Why not stamps, deliberately:

- **A collection is the owner's view, not data about the skill.** "The best
  skills, which happen to be from Nils" is one user's curation; stamping it
  onto the stored copy would version a private opinion into the store repo
  and every clone of it.
- **The triggering requirement was explicitly personal-only** ("works for me,
  never in the product's repo") — config-side data satisfies that by
  construction, exactly like the profile lists and the category vocabulary.
- **`category` is single-valued.** The families in question are already
  categorized across the content taxonomy; a bundle stamp would have to
  displace it.

## Consequences

- Collections do not travel: not with the store, not with the product, not to
  another machine (unless the user copies their config).
- Pattern lists are loose on purpose — an unmatched pattern draws a warning at
  `collection save` time, never an error (a collection may legitimately
  reference names not yet in the inventory).
- This is the recorded, deliberate exception to ADR-0013's
  data-on-the-skill rule; if collections ever need to be shared or
  machine-synced, that is a new decision superseding this one.

## Update (2026-08-19 — superseded in part by ADR-0017)

The "do not travel" consequence above is superseded by
[ADR-0017](0017-collections-and-profiles-travel-with-the-store.md):
collections (and profiles) now live as `<store>/collections.json` /
`<store>/profiles.json` and travel with the store repo — the exit clause this
ADR named. The decision's core stands unchanged: a collection is the owner's
view, never data stamped on a skill.
