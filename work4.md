# Work 4 — LLM Voice Lab (Quest #19180)

**Quest:** [An app, tool or agent about the LLM voice](https://github.com/pollinations/pollinations/issues/19180)
**Branch:** `work4-llm-voice-lab`
**Live:** <https://llmvoice.edgeone.cool>
**App key:** `pk_lT4to0x2XzMoK8f1`

## Goal

A tool about *the way language models write*: score any text for LLM-voice markers, watch two models talk about a paragraph in different voices, and play a "human or model" guessing game.

## Research notes

- Martin Fowler's bliki (29 Oct 2026): the LLM voice is recognizable prose that triggers an uncanny-valley reaction; it is *not* primarily em-dashes — it is clichéd extended metaphors ("load-bearing tapestries"), corporate-jargon phrases, and smoothness without soul (he prefers "a genuine human's clunky prose").
- A follow-up post shows a small model can be trained to deslop its own style — marker-aware rewriting works.
- Marker set implemented: em-dash density, "not just X but Y" constructions, rule-of-three lists, tapestry/weave/journey metaphors, "it's important to note", hedged confidence, uniform sentence rhythm, bullet-point gravity, "delve", "tapestry", "moreover", "in conclusion".

## What was built

- **Voice Scanner:** paste text, get an LLM-voice score (0-100) with a marker-by-marker breakdown (regex heuristics for cheap markers + Pollinations model analysis for style-level ones)
- **Voice Compare:** the same paragraph rewritten by 2-4 Pollinations models in parallel; a jury model ranks which sounds most human
- **Human or Model game:** 10 rounds, one text per round written by either a human or a Pollinations model (human samples are public-domain classics, model samples generate live) — guess and see the model's own tell
- **Deslopper:** rewrite your text to strip the LLM voice, with a before/after score delta
- BYOP via `<polli-connect app-key="pk_lT4to0x2XzMoK8f1">`
- Made with pollinations.ai badge

## Verification

- [x] scanner scores text and lists concrete markers
- [x] compare mode runs 2+ models in parallel and ranks them
- [x] game generates 10 playable rounds and scores the player
- [x] deslopper returns text with a lower voice score
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Deployment

- EdgeOne Pages project `llmvoice`, production deploy verified HTTP 200
- headless tests: scanner discriminates (LLM slop 98/100, human classic 0/100, Austen 0, synthetic 73), tabs switch, game round playable, model tools show the friendly connect-first error when unconnected

## Outcome

Shipped as quest submission for #19180.
