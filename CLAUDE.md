# CLAUDE.md

Project instructions. Read this before touching anything.

## What this is

A small LLM gateway built in TypeScript: routing, request logging, a guardrail
layer, cost accounting with budget enforcement, and a RAG endpoint.

Two purposes, in this order:

1. A live demo for a technical interview for an AI Platform Engineer role. It
   will be walked through in a screen share and the author will be asked to
   explain any line of it.
2. Afterwards, a reusable proof asset for the author's independent AI
   consulting practice, on the theme of AI spend control and guardrails.

Because of purpose 2, **do not name any company, client, or employer anywhere
in this repo.** Keep it vendor-neutral and generic.

## Who you are working with

The author has years of production JavaScript and React, and is deliberately
building this in TypeScript to close a stated gap. Assume strong general
engineering judgement and beginner-to-intermediate TypeScript.

He is working from a phone while travelling. That has consequences:

- **Small diffs.** One slice per commit, one concern per file. Never dump a
  400-line change he has to scroll through on a phone.
- **Explain in comments, not in chat.** When you use a TypeScript construct he
  may not know, put a short `// TS note:` comment above it explaining what it
  does and why. The comments are the teaching material and they survive the
  session.
- **Say what you changed in three lines max**, then stop. He will ask for more.

## The constraint that matters most

He must be able to explain this code out loud, under questioning, without
notes. That outranks cleverness, completeness, and elegance.

So: prefer the boring construct over the sophisticated one. If a fancier type
would save five lines but take ten minutes to explain, use the boring version.
No type gymnastics, no conditional types, no decorators, no clever generics
beyond what is already in `env.ts`.

If you are about to write something he would struggle to defend, write the
simpler thing and say so.

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
- Dependencies stay minimal. Current list is fastify, zod, pino-pretty. Adding
  one more needs a reason stated first. `better-sqlite3` is pre-approved for
  slice 3.

## Hard cut list

Do not build these, do not suggest them, do not "just quickly add" them:

streaming, retry and failover, multi-tenant auth beyond the static key, Docker,
Kubernetes, a React or Vue frontend, a build step, a vector database,
reranking, hybrid search, OpenTelemetry, a test framework beyond a handful of
plain assertions on guardrail rules.

If a slice is running long, cut depth inside that slice. Do not borrow time
from a later one.

## Working rhythm

- One git commit per slice, message format: `slice N: <what it does>`.
- Run `npm run typecheck` before every commit. It must be clean.
- After each slice is verified: spawn a subagent on Sonnet to update
  `docs/TECHNICAL.md` and `docs/USER.md` for what that slice added. The main
  agent must review the docs diff against the actual code before committing —
  the docs go in their own small `docs: <slice>` commit right after the slice
  commit. Docs document only what exists, never future slices as if built.
- After each slice, print the curl command that demonstrates it, so he can
  verify from the phone.
- When a slice is done, say which slice is next and stop. Do not chain into the
  next slice without being asked.

## State

All seven slices are complete and verified, plus the stretch response cache.
Demo assets exist: `DEMO.md` (the walkthrough) and `scripts/seed.sh`.
Documentation lives in `docs/TECHNICAL.md` and `docs/USER.md`.

Nothing on `PLAN.md` remains as code. Before adding anything new, re-read the
hard cut list above — the largest risk to this project is one more feature.
