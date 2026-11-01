---
name: self-eval
disable-model-invocation: true
description: 'Guide the user through writing their periodic performance self-evaluation. Triggers: "self-eval", "write my self-eval", "self evaluation", "perf review write-up".'
allowed-tools: AskUserQuestion, Write, Read, Bash, WebFetch, mcp__plugin_slack_slack__slack_search_public_and_private
---

# Self-Eval

Guides a full self-eval workflow: gather evidence → organize into themes → draft 4 questions → workshop.
Note: self-eval is a regular reflection process -- not tied to promotion cycles.

## Step 1: Ask upfront (all 3 in one AskUserQuestion call)

**Role** -- "What's your current role/level?"
- SE1 (Software Engineer 1)
- SE2 (Software Engineer 2)
- Senior Software Engineer
- Other (Staff, Manager, etc.)

**Team** -- "What team are you on?"
- Serverless Onboarding
- Other

**Goals** -- "Are you working toward anything specific right now?"
- "Promotion to the next level" -- "You're actively building a case for leveling up"
- "Deepening expertise in my current role" -- "You're focused on going deeper, not necessarily up"
- "Nothing specific right now" -- "Just want a solid self-eval"

## Step 2: Gather raw materials (last 6 months)

Load `acli` before gathering Jira evidence.

- **Jira**: use `acli` to find tickets completed or contributed to, larger initiatives, and cross-team work
- **Google Calendar**: meetings organized/presented, demos, planning sessions, cross-team syncs
- **Slack**: threads where you shared updates, gave technical guidance, or helped unblock others
- **GitHub/GitLab**: PRs authored/reviewed, especially tied to major features or improvements
- **Serverless Sync tracker** -- can't access directly; ask user to paste relevant rows. URL: `https://docs.google.com/spreadsheets/d/15psaKZS5Z9IpUcSoAKGpsihRb_Bb6Mz_PWEkpev8di8/edit?gid=1694270729`

Organize findings into themes: shipped features, cross-team work, mentorship, operational improvements, culture contributions. Present the themes and **ask if anything is missing before moving on.**

Then ask via AskUserQuestion:

**Impact numbers** -- "Do you have any concrete numbers that show impact? (e.g. adoption metrics, time saved, tickets closed, customers unblocked)"
- "Yes, let me share some" -- "I'll paste numbers or metrics in the follow-up"
- "Not sure, help me find some" -- "Let's look through Jira/Datadog/dashboards together"
- "No, not really" -- "We'll focus on qualitative impact instead"

## Step 3: Draft into `self-eval.md`

Each answer uses unique examples -- no repeating the same project across questions. If a project spans multiple answers, highlight a different aspect each time.

**Q1: What are you doing really well?** -- 2-3 strengths to keep leveraging.

**Q2: What would you like to do better?** -- 1-2 areas for development. First ask:

**Growth areas** (multiSelect) -- "What areas do you most want to grow in?"
- "Technical depth" -- "Going deeper on architecture, systems design, or domain expertise"
- "Leadership & influence" -- "Driving alignment, leading projects, or shaping team direction"
- "Mentorship & delegation" -- "Growing others, scoping work for teammates, coaching"
- "Communication" -- "Writing, presenting, cross-team visibility"

**Q3: Performance indicator** -- ask first:

**Indicator** -- "Which indicator feels right for this cycle?"
- "Needs Development" -- "Performance is below expectations for your level"
- "On Track" -- "Meeting expectations for your level"
- "Sets a New Standard" -- "Consistently exceeding expectations for your level"

Include a comment justifying the choice. Reference the career ladder: `https://datadoghq.atlassian.net/wiki/spaces/EPTP/pages/2274460164/Datadog+Software+Engineering+Career+Paths`

**Q4: What is your next step to reach your career goals?**

Tone throughout: specific, evidence-based, not falsely humble.

## Step 4: Workshop

After writing the file, tell the user you're ready to workshop it together -- refining wording, adjusting emphasis, adding missing context.
