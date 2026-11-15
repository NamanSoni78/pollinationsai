# Work 1 — Model Consensus (Quest #19183)

**Quest:** [An app or game about asking every model the same question](https://github.com/pollinations/pollinations/issues/19183)
**Branch:** `work1-model-consensus`
**Live:** <https://modelconsensus.edgeone.cool>
**App key:** `pk_OPaGyG1ZLe4qlyQ3`

## Goal

One question, every model. The app sends the exact same prompt to a whole panel of Pollinations text models at once, then shows every answer side by side and computes how much the models agree.

## Research notes

- modelcompare.ai asked 14 models the same "controversial take" question 3× each: 35 of 41 answers converged on one idea ("people choose belonging over truth"); the interesting content is the divergence and the outliers (Claude Opus 5.5 answered the opposite of the pack).
- Total cost of 68 calls was $1.69 — the format is cheap to run on Pollen.
- Repeating a prompt 3× separates conviction from sampling noise; worth surfacing as a metric.

## What was built

- a static single-page app, no build step
- model panel loaded live from `GET https://gen.pollinations.ai/v1/models` (text models, healthy, non-community), multi-select with quick picks
- same question fired at every selected model in parallel via `POST /v1/chat/completions` with the user's BYOP key
- answer cards stream in as each model finishes, with latency and token usage
- a consensus panel: one further model summarizes agreement, disagreement and outliers
- "Ask 3×" mode to test conviction of each model
- BYOP via `<polli-connect app-key="pk_OPaGyG1ZLe4qlyQ3">`
- Made with pollinations.ai badge in the footer

## Verification

- [x] page loads, model list fetches (446 models, 269 text)
- [x] question broadcast works with a connected key
- [x] answers render per model with latency
- [x] consensus summary generates
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19183.
