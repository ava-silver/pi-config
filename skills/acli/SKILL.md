---
name: acli
description: Use `acli` for Jira and Confluence. Load this skill whenever you work with either product.
user_invocable: false
---

# acli

Use `acli` directly for Jira and Confluence. Do not use an MCP server.

Use `--json` when you need structured output. For write commands, ask for confirmation when the user has not already requested the change, then pass `--yes`.

## Common commands

```bash
acli jira workitem view SVLS-123 --json
acli jira workitem search --jql 'project = SVLS' --json
acli jira workitem create --project SVLS --type Task --parent SVLS-XXXX --summary 'Title' --description-file description.md --label 'Team - SVLS' --json
acli jira workitem edit --key SVLS-123 --description-file description.md --yes --json
acli jira workitem link create --out SVLS-123 --in SVLS-456 --type Blocks --yes
acli confluence page view --id 123456789 --body-format view --json
```

Use `acli jira workitem create --generate-json` when you must set custom fields.

## SVLS Jira ticket defaults

| Field | Value |
|---|---|
| Project | SVLS (`15505`) |
| Issue type | Task (`10002`) |
| Team (`customfield_15831`) | Serverless Onboarding & Enablement (`22498`) |
| Labels | `["Team - SVLS"]` |
| Priority | Omit entirely |
| Assignee | Leave blank unless requested |
| Parent (epic) | Always required -- ask if not provided |

For custom fields, use `additionalAttributes` in the JSON passed to `--from-json`.

## Team IDs (`customfield_15831`)

| Team | ID |
|---|---|
| Agent | 19143 |
| APM | 19141 |
| App | 19140 |
| Data | 19139 |
| DevEx | 19142 |
| Integrations | 19144 |
| Serverless AWS | 22447 |
| Serverless Azure | 22448 |
| Serverless Cloud Tracing | 22451 |
| Serverless Edge Computing | 22450 |
| Serverless Experiences | 22449 |
| Serverless Onboarding & Enablement | 22498 |

Return ticket URL: `https://datadoghq.atlassian.net/browse/<KEY>`

## Troubleshooting

If a command reports an authentication error, run `acli auth login` and retry.
