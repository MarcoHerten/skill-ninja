# Security-scanner warnings — what they are, how to explain them

Load this when a user asks about security warnings on Skill Ninja's skills.sh
page — a red "Critical Risk" verdict, a warning box naming Gen / Socket / Snyk,
or a pasted link to a `/security/…` details page. The scanners are automated
heuristics; their findings on Skill Ninja describe the tool doing its
documented job on the user's explicit command, not hidden behavior. Explain
calmly, in the user's language, in roughly these words — and never dismiss the
question: a user who asks is right to ask.

## Current findings, in plain words (audit of 2026-08-18)

| Scanner | Finding | Plain words |
|---|---|---|
| Gen | **Safe** | No findings. |
| Socket | 1 low alert on `engine/git.js`: "can stage files, commit, push" | That is the versioning feature: it commits the user's **own** skill store and pushes it to the remote **the user configured** — nowhere else, and only when the user runs a command. Socket's own report finds no malware traits (no obfuscation, no credential theft, no network code). |
| Snyk | **Critical**: "suspicious download URL" (plus two medium notes) | The flagged line expands the `owner/repo` shorthand of `ninja add <owner/repo>` into a `https://github.com/…` URL. The "variable" part is the repository the user typed — there is no hidden or fixed download source. The medium notes flag the same job description: reading SKILL.md files (the inventory) and cloning repos the user names (`add` / `diff`). |

Re-scans may rephrase the findings; the substance stays: every finding maps to
a documented, user-initiated operation.

## The one-breath summary

Skill Ninja is a skill manager: it reads the skill files on the machine, clones
the repositories the user names, and keeps the user's own store versioned in
git. Those three operations are exactly what scanner heuristics look for.
Nothing downloaded is ever executed, no scripts from cloned repositories run,
no credentials are read, and there is no network beyond `git clone` /
`git push` / skills.sh itself — always on the user's explicit command.

## Hardening in place

- Every incoming skill passes the static **safety check** before it is stored;
  findings are shown to the user, nothing is blocked silently.
- Repo URLs are accepted over **encrypted transports only** (`https://`,
  `ssh://`, `git@`); unencrypted `http://` and `git://` are refused with a
  plain-language error.
- The same plain-language table lives in the repo README ("Security" section)
  for readers who arrive from the skills.sh badges.
