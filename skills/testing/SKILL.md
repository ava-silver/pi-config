---
name: testing
description: 'Testing guidelines for all test work (unit, integration, etc.). Use when adding, changing, requesting, or reviewing tests.'
---

# Behavior Testing

Use behavior tests to prove behavior that a caller observes. Choose the smallest test level that gives behavior evidence.

## Unit tests

A behavior unit test exercises a unit's public boundary and asserts its observable output, state, or effect. Use one when that boundary can prove the required behavior.

## Integration tests

A behavior integration test exercises the real boundary between components. Use one when behavior crosses that boundary, and validate the resulting behavior through a representative consumer. For integration tests, use parallel execution where possible to speed up test execution.

## Test scope

Write behavior tests for meaningful business behavior. When a unit has no such logic, omit its unit test. Assert required, observable behavior instead of implementation structure.

## Avoid

- Change-detector tests. Prove required, observable behavior instead.
- Regression tests -- or requests for them during review -- unless the user explicitly asks.
