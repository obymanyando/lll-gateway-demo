# KICKOFF.md

The first message to send Claude Code. Copy the block below verbatim.

---

```
Read CLAUDE.md, PLAN.md, and HANDOFF.md before doing anything.

Context: I'm building an LLM gateway in TypeScript as a live demo for a
technical interview. I have production JavaScript experience but I'm new to
TypeScript, and the whole point is that I have to be able to explain every line
of this out loud under questioning. I'm working from a phone while travelling,
so keep diffs small and put your TypeScript explanations in code comments
rather than in chat.

Slice 1 is already written and verified. If src/ is missing from this repo,
recreate it verbatim from HANDOFF.md first, commit it, and stop.

If src/ is already here: run npm install and npm run typecheck to confirm the
baseline is green, then start slice 2 (the router) from PLAN.md.

Before you write any code for slice 2, tell me in five lines or less what
you're going to change and which files. Then wait for me to say go.
```

---

## After each slice

```
Show me the curl command that demonstrates this slice, and the three lines of
what changed. Then stop.
```

## When something in the code does not make sense

```
Explain <thing> in the context of this file. Assume I know JavaScript well and
TypeScript barely. Two paragraphs max, then add it as a // TS note: comment in
the code so it sticks.
```

## When you feel the urge to add something not in PLAN.md

Do not. Send this instead:

```
Log that as a line in PLAN.md under "Stretch" and carry on with the current
slice.
```
