# Work 3 — SciExplorer (Quest #19181)

**Quest:** [An app that turns a science topic into something you can explore](https://github.com/pollinations/pollinations/issues/19181)
**Branch:** `work3-sciexplorer`
**Live:** <https://sciexplorer.edgeone.cool>
**App key:** `pk_oB2HjsRMIdhoRiDe`

## Goal

Type a science topic, get an interactive visual explanation you can click, drag and explore — built live by Pollinations models on the user's own Pollen.

## Research notes

- Anima (github.com/Garinmckayl/anima) is the reference: single standalone HTML figure, dark/light themes, one small model driving both motion and readout, every part hover-explainable, pause on Space, a sources block and an explicit list of simplifications.
- Anima's five principles adopted as the generation standard: show the real structure; every number cited; say how sure we are; make it move for a reason; educational, never advice.
- Pollinations text models write the explanation and the interactive figure code; an image model renders a hero illustration.

## What was built

- a static app: enter a topic (or pick a preset), choose a detail level
- generation pipeline on BYOP key: outline (text model) → interactive figure as self-contained HTML+JS (text model) → hero image (image model) → audio narration toggle (audio model)
- output is an interactive canvas/SVG explanation with sliders, toggles and hover explanations, rendered in a sandboxed iframe
- every generated figure carries a sources block and a simplifications list (both written by the model)
- gallery of previously generated topics (localStorage)
- BYOP via `<polli-connect app-key="pk_oB2HjsRMIdhoRiDe">`
- Made with pollinations.ai badge

## Verification

- [x] page loads; preset topics generate end to end
- [x] generated figure is interactive (sliders/toggles respond)
- [x] sources and simplifications blocks render
- [x] hero image generates
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19181.
