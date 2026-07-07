# Report Standards

The owner's rule: reports must read like **good research papers** — deep, specific,
containing exactly the information that is needed, and nothing else. A short, dense
report beats a long, padded one. Spam is a firing offense.

## Required structure (front matter + sections)

```markdown
---
title: <specific claim-bearing title>
task: TASK-...
team: <team-id>
authors: [<agent-ids>]
status: draft | approved
reviewed_by: <reviewer-id>       # set by the reviewer only
review_verdict: approved | revise
revision: 1
date: YYYY-MM-DD
---
## Abstract          — 3-6 sentences: question, method, findings, recommendation.
## Introduction      — REQUIRED. Written so a motivated high-schooler can follow it, which
                       means PLAIN LANGUAGE, not less substance. Take as much room as the
                       topic needs — this section is NOT kept short. "High-school level" is
                       about accessibility, not simplification: be specific and concrete, and
                       when you introduce a technical term or an equation, define it in plain
                       words right there and give the intuition (what it means, why it's used,
                       a worked example if it helps). Being vague to sound simple is the
                       failure mode to avoid — tell the owner exactly what is going on at a
                       level he can actually learn from. This is not the Abstract restated:
                       the Abstract says what to DO; the Introduction teaches what the topic IS
                       and builds the reader up to the technical sections. This whole document
                       is a research paper a professor would write — rigorous and deep — and
                       the Introduction is its accessible on-ramp, not a dumbed-down summary.
## Background        — what the sim does today. Every claim cites a repo path or a
                       structure.md section anchor. No generic textbook filler.
## Analysis          — the actual research. Quantitative wherever possible: numbers,
                       complexity, parameter ranges, trade-off tables.
## Proposal          — concrete recommendation against the actual code (name files,
                       systems, data structures). Include an implementation sketch.
## Limitations       — what this analysis does not cover; where it could be wrong.
## Open questions    — follow-ups worth a future task (each one specific).
## References        — repo files, structure.md anchors, external sources with URLs.
```

## Quality bar (reviewer checklist)

- [ ] Every factual claim about the sim cites a file path or doc section.
- [ ] The proposal names the real systems/files it would change.
- [ ] Numbers over adjectives: "reduces neighbor search from O(n²) to O(n)" not "much faster".
- [ ] No restating what the task brief already says; no boilerplate introductions.
- [ ] Abstract alone tells the owner what to do and why.
- [ ] The Introduction is genuinely followable by a high-schooler AND specific, not vague:
      no undefined jargon, no equation without a plain-English gloss and intuition, but also
      no hand-waving that hides the real detail. Length is whatever the topic needs — do not
      reject it for being long; reject it for being vague, jargon-dense, or a restated Abstract.
- [ ] Length proportional to content: if a section has nothing non-obvious, it is one line.

## Review protocol

- Drafts live in `company/reports/<team>/drafts/`. The author mails the team reviewer
  (`kind: request`) when a draft is ready.
- The reviewer replies with `kind: review-comment` mail; verdict `revise` bounces the
  draft back with specific, actionable comments (quote the offending passage).
- On `approved`: the reviewer writes the final file to
  `company/reports/<team>/YYYY-MM-DD-<slug>.md` with `status: approved`, `reviewed_by`,
  and `revision` set, and marks the task `status: done`.
- Two rounds of revision without convergence → escalate to the team lead by mail.
- Claims that can be validated by running code should be: file an owner request for the
  run (see COMPANY.md conventions) and cite its id and result in the report. "Compiles
  clean (REQ-...: exit 0)" beats "should compile".
