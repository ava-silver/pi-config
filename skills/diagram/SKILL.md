---
name: diagram
description: "Create a Mermaid diagram"
---

## Before Writing Anything

Try to infer the following, and only ask the user to clarify what they're looking for if its not clear based on the existing context:

- What are you trying to represent? Is it the shape of the infrastructure or code? Is it the flow of data? Something else?
- What is in scope? What is worth including versus should be glossed over for the sake of simplicity?
- What layout makes sense? In general, prefer square-ish over super narrow ones, and prefer left to right or top to bottom if theres a general direction.
- Whether labels need to be short/abbreviated or can be verbose

## Readability Principles

- **Keep labels short** -- node labels under ~30 chars
- **Use concrete code anchors** -- name relevant repositories and files in node labels or subgraphs when they help orient the reader (for example, `serverless-ci / Dockerfile`).
- **Avoid crossing edges** -- arrange nodes to minimize overlaps; prefer `TD` for hierarchies, `LR` for pipelines
- **Group related nodes** with `subgraph` blocks, but only when they add clarity
- **No wall-of-text nodes** -- if a label needs explanation, add a note to the user when presenting the diagram, not in the node

## Workflow

1. Clarify (if needed) the above questions
2. If the output is to be inline in a GitHub PR/issue descriptions, existing Markdown file, Confluence, or any context that renders Mermaid natively: output the diagram as a fenced `mermaid` code block.
3. If the output isn't specified or is explicitly asked to be displayed, use a `.mmd` file (tmp file unless specified), and then spin up a background terminal to render it using `tldraw-mermaid /path/to/diagram.mmd`. This will open the mermaid diagram in the user's browser. Note that any updates to the file will cause it to re-render, losing any user changes. Only kill the rendering process once it's clear the user no longer needs it.
