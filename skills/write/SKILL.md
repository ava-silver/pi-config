---
name: write
description: 'Guidelines for writing concise, focused English prose (docs, PR descriptions, comments, articles, READMEs) that stays tight without reading choppy. Apply whenever writing or editing markdown prose. Triggers: "/write", writing docs/READMEs, drafting a PR description, writing comments or article prose.'
---

Write *tight*: the shortest prose that still flows, carrying only what the reader can act on.

## Before writing: orient first

Infer the answers to these from context (the artifact type, the surrounding content, the request itself). Only ask the user when there's no signal to go on.

Three questions to answer before drafting:

**Who is reading this?** A PR reviewer has the diff open and needs to know *why* -- not *what* changed. A new contributor needs enough to get unstuck, not a tour of every decision. A teammate scanning a changelog wants impact, not implementation. A reader of an incident report needs facts and next actions, not speculation or narrative color.

**What do they already know?** Strip context they already have (the code, the surrounding doc, the repo history). Only add context that's genuinely invisible to them -- the intent, the tradeoff, the edge case that isn't obvious.

**What register fits?** Match the artifact's natural register -- a code comment is clinical and minimal; a README is instructional, patient, and to the point; a tech blog post can be conversational; a runbook is terse and imperative. Don't bring a blog tone to a PR description or a formal report tone to an internal doc.

## Format

Use prose for explanations and narrative. Use bullets when items are parallel and independent. Use a table when comparing multiple things across the same attributes. Don't reach for bullets just to avoid writing sentences.

## Pillars

- **Relevant** -- every sentence earns its place by telling the reader something they act on and can't already see in the code, diff, or surrounding context. Skip what they'd infer on their own.
- **Tight** -- lead with the point, one idea per sentence, concrete noun and active verb over abstraction. Length follows content, never a quota.
- **Present-tense** -- describe the current state. Leave out the history of how it got there and how earlier versions differed.

Read each sentence in isolation and ask: does it change what the reader now knows or does? A sentence that only restates the visible context, warms up to a point, or hedges is a no-op -- delete the whole sentence rather than trim its words.

Only reach for a hype word (*seamless*, *powerful*, *robust*) when it carries information the reader lacks; otherwise the concrete detail says more.
