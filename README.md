# Model Consensus

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**One question, every model.** Ask the same question to a whole panel of AI models at once — answers stream in live, then one model summarizes where they agree, where they diverge, and what surprised it.

Built for Pollinations quest [#19183 — An app or game about asking every model the same question](https://github.com/pollinations/pollinations/issues/19183).

## What it does

- **Model panel** — loads every healthy text model from the Pollinations catalog live (260+ models from OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Qwen, Moonshot and more), with quick picks (Big 8 labs, Fast 6, Frontier 5, Open weights).
- **Same question, parallel ask** — your prompt goes to every selected model at once through one API; each answer card shows the model, latency and text as it arrives.
- **Ask 3× mode** — send the question three times per model and see a *conviction* score (how consistent each model's answer is across runs), the way modelcompare.ai did for the "controversial take" post.
- **Consensus read** — a summarizer model reads all the answers and writes: the consensus, the outliers, and the surprises.

## Paying with your own Pollen

The app uses **Pollinations Pay (BYOP)**: press **Connect**, authorize the app, and every request runs on *your* Pollen balance with a budget you control. The app never pays for your usage and your key stays in your session.

## Run locally

No build step. Serve the folder and open it:

```bash
cd pollinations-consensus
python3 -m http.server 8000
# open http://localhost:8000
```

Files: `index.html` · `app.js` · `pollinations.js` · `polli-common.js` · `polli.css`

## How it talks to Pollinations

| Call | Endpoint |
| ---- | -------- |
| Model catalog | `GET https://gen.pollinations.ai/v1/models` (public) |
| Ask a model | `POST https://gen.pollinations.ai/v1/chat/completions` with the user's BYOP key |
| Consensus summary | streamed `POST /v1/chat/completions` |

## Credit

Credit Pollinations — Made with [pollinations.ai](https://pollinations.ai/?ref=badge).
