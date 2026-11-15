[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# SciExplorer

**Turn a science topic into something you can explore.** Type any topic — "how a refrigerator works",
"neuron firing", "plate tectonics" — and SciExplorer builds an interactive visual explanation around it:
a live, animated figure with sliders and toggles that change the actual mechanism, a cited section-by-section
walkthrough, a hero illustration, optional narration audio, and an honest list of what was simplified.

Built for Pollinations.ai quest #19181. Design principles adopted from
[Anima](https://github.com/Garinmckayl/anima):

1. **Show the real structure** — the figure draws the actual mechanism and its named parts, not a vague metaphor.
2. **Every number cited** — quantities shown in the figure and text are traceable to real sources.
3. **Say how sure we are** — a dedicated *Simplifications & confidence* block lists approximations and confidence levels.
4. **Make it move for a reason** — animation is causality (particles, flows, waves move because of the physics), never decoration; controls change the simulation itself.
5. **Educational, never advice** — the app teaches science and never gives medical, financial or professional advice.

## What it does

1. **Input** — a topic text field, five preset chips (refrigerator, neuron firing, plate tectonics, antibodies vs viruses, why the sky is blue) and a detail level (quick / standard / deep).
2. **Outline step** (`openai/gpt-5.4-nano`) — plans the explanation as JSON: `{title, sections:[{heading, explanation, visual:{type:"interactive", spec}}], sources, simplifications}`. The spec explicitly demands a figure where sliders/toggles **change the mechanism**, not the colors.
3. **Figure step** (`openai/gpt-5.4`, streamed) — writes a complete self-contained HTML document (dark theme `#0d0f14` / accent `#f5c518`, canvas or SVG, `requestAnimationFrame` animation, at least one simulation-changing slider/toggle, hover explanations on every part, Space-bar pause). The code streams live into a `<pre>` viewer and then renders in a **sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`), so the generated figure can never touch the page, your key or your data.
4. **Hero image** — `client.imageUrl(topic + ' scientific diagram illustration', {width:1024, height:576})` via the image endpoint.
5. **Narration (optional toggle)** — a *Listen* button per section builds `client.audioUrl(explanation.slice(0,300))` and plays it in an `<audio controls>` element.
6. **Gallery** — every exploration is saved to `localStorage` (`{topic, date, detail, outline, figureHtml, imageUrl}`) and listed for one-click re-opening; entries can be deleted individually.
7. **Progress UI** — a three-step tracker (outline → figure → image) with live timings; figure code streams into the code pane while it is generated.

## How to run

Pure static files — no build step, no npm.

```bash
cd pollinations-sciexplorer
python3 -m http.server 8000
# open http://localhost:8000
```

Then press **Connect** (top right) to link your Pollen and pay with your own balance.

## How it uses Pollinations

| Step | Endpoint | Model | Auth |
| --- | --- | --- | --- |
| Header connect, key, budget | `enter.pollinations.ai` (`<polli-connect>` web component) | — | app key `pk_oB2HjsRMIdhoRiDe` |
| Outline plan (JSON) | `POST https://gen.pollinations.ai/v1/chat/completions` | `openai/gpt-5.4-nano` | user Pollen key (BYOP) |
| Interactive figure HTML (streamed) | `POST https://gen.pollinations.ai/v1/chat/completions` (`stream:true`) | `openai/gpt-5.4` | user Pollen key (BYOP) |
| Hero illustration | `GET https://gen.pollinations.ai/image/{prompt}?width=1024&height=576` | `black-forest-labs/flux.1-schnell` | user Pollen key (BYOP) |
| Section narration | `GET https://gen.pollinations.ai/audio/{voice}/{text}` | `openai/tts-1` | user Pollen key (BYOP) |
| Model list / badges | `GET https://gen.pollinations.ai/v1/models` · badge CDN | — | public |

## BYOP — Bring Your Own Pollen

SciExplorer never runs on a shared or developer key. The `<polli-connect>` button (top right) connects
**your** Pollinations account for app key `pk_oB2HjsRMIdhoRiDe`, scoped to text, image and audio generation
within a small budget. Every outline, figure, image and narration call is billed to **your own Pollen balance**,
so you pay only for what you generate. The key is kept in the page session and is never stored anywhere else
by this app. If you are not connected, every generate action shows a friendly reminder instead of firing a call.

## Safety

- Generated figures render inside `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`: opaque origin, no access to `localStorage`, cookies, the parent page or your API key. Figures are also prompted to make zero external requests.
- Markdown fences around model output are stripped before rendering; the HTML is trimmed to `<!DOCTYPE html>…</html>` boundaries and sanity-checked (must contain `<script>` + `<style>` + canvas/SVG/animation) before it is mounted.
- Model-cited sources are starting points for your own reading, not endorsements — and none of this is medical, financial or professional advice.

## Files

- `index.html` — page shell, controls, progress steps, gallery and result containers
- `app.js` — pipeline (outline → streamed figure → image), rendering, narration, gallery, safety checks
- `pollinations.js`, `polli-common.js`, `polli.css` — shared Pollinations foundation (client, page chrome, design system)

Credit Pollinations — Made with pollinations.ai
