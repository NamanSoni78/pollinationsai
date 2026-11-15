# Work 5 — WorldSim Terminal (Quest #19179)

**Quest:** [An app or game where a model plays a machine](https://github.com/pollinations/pollinations/issues/19179)
**Branch:** `work5-worldsim-terminal`
**Live:** <https://worldsim.edgeone.cool>
**App key:** `pk_vNm1pZT9oOBiVlQd`

## Goal

A terminal in the browser with no real computer behind it: a Pollinations model *plays the part of* the machine — it answers every command as if a whole world existed, and the world stays consistent.

## Research notes

- WorldTUI (simedw.com, 654 pts HN): a 360M model predicts how a terminal screen changes per keypress; no real shell — the world maintains itself; users probe the illusion's edges for fun (typos, weird commands, passwords).
- Per-command granularity feels alive; failures being funny is a feature, not a bug.
- nesformer: an NES CPU compiled into model weights — a model playing a specific machine.

## What was built

- a fake terminal (CRT-styled) where every command goes to a Pollinations text model playing the OS
- the model receives: command history, the "filesystem" it has invented so far, and a machine persona (linux-ish server in a strange world, with secrets to find)
- state persists: files `cat`ed earlier return consistent content because the app replays the invented filesystem to the model each turn and caches its outputs
- multiple machine personalities to boot: `linux`, `haunted-vax`, `nes-console`, `alien-mainframe`
- secret-hunt game layer: certain commands unlock discoveries; a progress panel tracks what you have found
- BYOP via `<polli-connect app-key="pk_vNm1pZT9oOBiVlQd">`
- Made with pollinations.ai badge

## Verification

- [x] terminal boots, commands produce machine-style output
- [x] filesystem consistency: create file, cat it back, ls shows it
- [x] personality switching works
- [x] secrets discoverable and tracked
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19179.
