# CLAUDE.md

Project instructions. Read this before touching anything.

## What this is

A small LLM gateway built in TypeScript: routing, request logging, a guardrail
layer, cost accounting with budget enforcement, and a RAG endpoint.

It is a reference implementation on the theme of AI spend control and
guardrails. Keep it vendor-neutral and generic: **do not name any company,
client, or employer anywhere in this repo.**

## How to work on it

- **Small diffs.** One slice per commit, one concern per file. Never dump a
  400-line change into a single review.
- **Explain in comments, not in chat.** When a TypeScript construct is not
  self-evident, put a short `// TS note:` comment above it explaining what it
  does and why. The comments are the documentation that survives.
- **Say what changed in three lines max**, then stop.

## The constraint that matters most

Every line here should be defensible in a code review without notes. That
outranks cleverness, completeness, and elegance.

So: prefer the boring construct over the sophisticated one. If a fancier type
would save five lines but take ten minutes to explain, use the boring version.
No type gymnastics, no conditional types, no decorators, no clever generics
beyond what is already in `env.ts`.

If you are about to write something hard to justify to the next reader, write
the simpler thing and say so.

## Non-negotiables

- `strict: true` and the extra flags in `tsconfig.json` stay on. Never soften
  them to make an error go away.
- No `any`. Use `unknown` plus a narrowing check.
- No `as` casts to escape a type error. If external data needs a type, run it
  through a zod schema. `as const` is fine.
- No non-null `!`. Handle the undefined case explicitly.
- Failures return `Result`, they do not throw. See `src/types.ts`.
- Provider HTTP calls stay as plain `fetch`. No vendor SDKs. The token usage
  fields are the whole point of the cost layer and an SDK hides them.
- Dependencies stay minimal: fastify, zod, pino-pretty, better-sqlite3. Adding
  one more needs a reason stated first.

## Hard cut list

Do not build these, do not suggest them, do not "just quickly add" them:

streaming, retry and failover, multi-tenant auth beyond the static key, Docker,
Kubernetes, a React or Vue frontend, a build step, a vector database,
reranking, hybrid search, OpenTelemetry, a test framework beyond a handful of
plain assertions on guardrail rules.

If a slice is running long, cut depth inside that slice rather than borrowing
scope from a later one.

## Working rhythm

- One git commit per slice, message format: `slice N: <what it does>`.
- Run `npm run typecheck` before every commit. It must be clean.
- After each slice is verified: spawn a subagent on Sonnet to update
  `docs/TECHNICAL.md` and `docs/USER.md` for what that slice added. The main
  agent must review the docs diff against the actual code before committing —
  the docs go in their own small `docs: <slice>` commit right after the slice
  commit. Docs document only what exists, never future slices as if built.
- **All work stays on a feature branch. Never merge to `main` on your own.**
  `main` is the published state: the repo is public and `docs/` on `main` is
  served as a live GitHub Pages site, so anything that reaches `main` is
  immediately public. Merging is therefore a deliberate act the author takes
  after verifying the branch — not a step in this rhythm, not something to do
  because a slice looks finished, and not something to offer to do "while
  we're here". Commit and push to the branch, then stop and say it is ready.
- Consequences of that setup worth knowing:
  - A docs commit on a feature branch changes nothing publicly. The site only
    rebuilds once the author merges, which is what makes the branch safe to
    iterate on.
  - Any **new** file under `docs/` needs YAML front matter (`---` / `title:` /
    `---`) or Jekyll serves it as raw text. There is no build error to warn
    you, so it fails silently.
- The repo is public. Keep it free of personal context: no employer, client,
  or company names, and nothing about who is building it or why.
- After each slice, print the curl command that demonstrates it.
- When a slice is done, say which slice is next and stop. Do not chain into the
  next slice without being asked.

## State

All seven slices are complete and verified, plus the stretch response cache.
`WALKTHROUGH.md` and `scripts/seed.sh` exercise the whole thing end to end.
Documentation lives in `docs/TECHNICAL.md` and `docs/USER.md`.

Nothing on `PLAN.md` remains as code. Before adding anything new, re-read the
hard cut list above — the largest risk to this project is one more feature.
