# Work 6 — AI Debate Stage (Quest #19178)

**Quest:** [An app or game where AIs talk to each other](https://github.com/pollinations/pollinations/issues/19178)
**Branch:** `work6-ai-debate-stage`
**Live:** <https://aidebate.edgeone.cool>
**App key:** `pk_UGk679hhEaxXgbeC`

## Goal

Two or more AI personalities talk to each other on a live stage: pick personas, pick models, give a topic, and watch the conversation unfold — with voices.

## Research notes

- The r/ChatGPT viral video ("two AI agents in a job interview and neither knows how to hang up", 10k upvotes) shows the appeal: awkward, funny, self-perpetuating AI-to-AI dialogue.
- Pollinations has everything needed in one API: text models for the minds, TTS voices for the mouths, STT if you want to speak to them.

## What was built

- a stage app: 2-4 AI personas, each bound to a Pollinations text model and a TTS voice
- conversation modes: debate (for/against), interview (interviewer/candidate that must end every answer with a question), free chat, therapy session
- moderator model (third model) can steer, interrupt on repetition, and call the winner at the end
- talk turns stream in as chat bubbles; TTS speaks each line through the Pollinations audio endpoint
- live intervention: the user can interject as a third voice or nudge a persona mid-conversation
- hang-up-easter-egg mode where both personas are instructed to always end with a question (the viral bit)
- BYOP via `<polli-connect app-key="pk_UGk679hhEaxXgbeC">`
- Made with pollinations.ai badge

## Verification

- [x] 2-persona debate runs multiple turns without user input
- [x] each persona uses its own model and voice
- [x] TTS playback works per line
- [x] moderator can be enabled and calls a winner
- [x] user interjection mid-conversation works
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19178.
