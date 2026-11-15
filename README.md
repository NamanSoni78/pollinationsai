# Pollinations Quest Worklog

This branch (`worklog`) is the working log for nine quest apps built on [Pollinations](https://pollinations.ai), each shipped for a POLLEN-QUEST bounty on the [`pollinations/pollinations`](https://github.com/pollinations/pollinations) repository.

Every app:

- is a self-contained static web app with no build step
- runs on Pollinations text, image and audio models through the [Pollinations API](https://gen.pollinations.ai/docs)
- lets users pay with their own Pollen via **Pollinations Pay / BYOP** (Bring Your Own Pollen)
- carries the *Made with pollinations.ai* badge and credit

## Works

| Work | Log | Quest | App | Branch | Live URL |
| ---- | --- | ----- | ---- | ------ | -------- |
| 1 | [work1.md](work1.md) | [#19183](https://github.com/pollinations/pollinations/issues/19183) — ask every model the same question | Model Consensus | `work1-model-consensus` | <https://modelconsensus.edgeone.cool> |
| 2 | [work2.md](work2.md) | [#19182](https://github.com/pollinations/pollinations/issues/19182) — a game AI agents play over MCP | MCP Arena | `work2-mcp-arena` | <https://word-duel-arena.edgeone.cool> |
| 3 | [work3.md](work3.md) | [#19181](https://github.com/pollinations/pollinations/issues/19181) — a science topic you can explore | SciExplorer | `work3-sciexplorer` | <https://sciexplorer.edgeone.cool> |
| 4 | [work4.md](work4.md) | [#19180](https://github.com/pollinations/pollinations/issues/19180) — about the LLM voice | LLM Voice Lab | `work4-llm-voice-lab` | <https://llmvoice.edgeone.cool> |
| 5 | [work5.md](work5.md) | [#19179](https://github.com/pollinations/pollinations/issues/19179) — a model plays a machine | WorldSim Terminal | `work5-worldsim-terminal` | <https://worldsim.edgeone.cool> |
| 6 | [work6.md](work6.md) | [#19178](https://github.com/pollinations/pollinations/issues/19178) — AIs talk to each other | AI Debate Stage | `work6-ai-debate-stage` | <https://aidebate.edgeone.cool> |
| 7 | [work7.md](work7.md) | [#19177](https://github.com/pollinations/pollinations/issues/19177) — AI agents left alone in a world | Idle Agents Island | `work7-idle-agents-island` | <https://idleisland.edgeone.cool> |
| 8 | [work8.md](work8.md) | [#19176](https://github.com/pollinations/pollinations/issues/19176) — a game that AI models play | Decision Arena | `work8-decision-arena` | <https://decisionarena.edgeone.cool> |
| 9 | [work9.md](work9.md) | [#17999](https://github.com/pollinations/pollinations/issues/17999) — tower of AI-run companies | Pollen Towers | `work9-pollen-towers` | <https://pollentowers.edgeone.cool> |

## Conventions

### Markdown discipline

- one `#` H1 per file; `##` for sections, `###` for subsections; no skipped levels
- blank line before and after every heading, list, code fence and table
- fenced code blocks always declare a language
- tables always have a header row and an alignment row
- no trailing whitespace; every file ends with exactly one newline
- links are reference-style where reused, inline otherwise

### Git conventions

- `worklog` is an orphan branch (empty, no upstream base)
- each app lives on its own branch `work<n>-<description>`, started from scratch (no `pollinations/pollinations` base, per the task rules)
- commits follow `work<n>: <what changed>`

### Credit

Every app README carries the badge:

```markdown
[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)
```

and the app pages show:

```html
<a href="https://pollinations.ai/?ref=badge">
  <img
    src="https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg"
    alt="Made with pollinations.ai"
  >
</a>
```

Credit Pollinations — Made with pollinations.ai.
