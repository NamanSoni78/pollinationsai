# Issue 125 — the nine first-party ElevenLabs speech fetches have no deadline (the round-37 handoff, verbatim)

- **Severity:** Medium (the issue-51/115 class: a silent or stalling model server pins the request — and its generation slot — indefinitely on nine paid synthesis/upload legs)
- **Affected (all on `8fc4c21`):**
  - `gen.pollinations.ai/src/routes/audio.ts` `generateElevenLabsSpeech` (:493 POST /v1/text-to-speech/{voice})
  - `generateElevenLabsSpeechWithTimestamps` (:559 POST …/with-timestamps)
  - `generateElevenLabsDialogue` (:645 POST /v1/text-to-dialogue)
  - `changeVoiceWithElevenLabs` (:760 POST /v1/speech-to-speech/{voice})
  - `isolateVoiceWithElevenLabs` (:822 POST /v1/audio-isolation)
  - `uploadMusicReference` (:1701 POST /v1/music/upload)
  - `generateMusic` (:1837 POST /v1/music)
  - `generateSoundEffect` direct leg (:1989 POST /v1/sound-generation)
  - `gen.pollinations.ai/src/audio/stem-separation.ts` `handleStemSeparation` (:143 POST /v1/music/stem-separation)
- **Fix branch:** `solution125-elevenlabs-speech-deadlines` (off `upstream/main` `8fc4c21`) — fork PR [#140](https://github.com/NamanSoni78/pollinationsai/pull/140)
- **Dedup:** issue 51 = ZONOS3 (both hops), issue 3 = AssemblyAI (240 s poll), issue 86/98 = fal queue/Lyria fal-leg, issue 115 = artifact *downloads* (SFX-fal/Qwen/SA3/sonilo — a different mechanism: downloads vs synthesis), issue 120 (round 39) = the transcription fleet's fetches. None cover the ElevenLabs speech/music legs. Round 37 recorded them below-gate as the "9 undeadlined ElevenLabs fetches" half of the audio handoff; the byte-cap half (the WAV-repair product call) remains a product decision and is untouched here.

## Root cause

All nine legs call `api.elevenlabs.io` with no `AbortSignal`, so a provider that accepts the request and then stalls (or a network path that blackholes) holds the worker invocation for as long as the platform proxy allows — with no bound of the code's own. Every other first-party fleet got deadlines in rounds 33–39; these nine were the recorded remainder.

## Safe repro (deterministic offline; live probes $0)

`gen.pollinations.ai/test/audio/elevenlabs-speech-deadlines.test.ts`, 7 cases (the music case asserts both the upload and the synthesis legs, so all nine sites are covered), **7 red on unpatched `8fc4c21`**: each invocation is made against a fresh-Response provider mock and the recorded `api.elevenlabs.io` call is asserted to carry `init.signal instanceof AbortSignal` — on main every `init.signal` is `undefined`.

## Fix

Pass `AbortSignal.timeout(300_000)` on all nine sites — the community endpoints' documented upstream budget (`COMMUNITY_ENDPOINT_TIMEOUT_MS`), chosen so a legal maximum cannot be broken: the 10,000-character input cap yields ~833 s of audio, and a streaming synthesis at even 3× realtime completes in ~278 s, inside 300 s. (A 120 s value, the transcription fleet's convention, would abort legal max-size streaming syntheses.)

## Tests

**GREEN with the fix:** 7/7; the nine sibling suites (`elevenlabs-tts`, `tts-timestamps`, `voice-changer`, `dialogue`, `voice-isolator`, `elevenmusic-v2`, `elevenlabs-sfx`, `stem-separation`, plus the new file) green — 81 passed + 6 skipped across 9 files; `tsc --noEmit` clean.

## Residuals (recorded for the next round, from the same sweep)

Other first-party speech fetches still without deadlines, outside this branch's scope: Qwen TTS synthesis (:2428), Fish speech (:2555), the OpenRouter speech-usage poll (:3012), OpenRouter Gemini speech (:3076), xAI TTS (:3142), Azure tts-1 (:3214), DeepInfra TTS (:3273), Lyria-3-clip (:2136) — plus the ElevenLabs Scribe *transcription* fetch (:1513, issue 120's branch) and the artifact-download legs (issue 115's branch). The WAV-repair byte cap (round 37/38's product call) and the ElevenLabs WAV 44–74 MB legal single-request envelope remain below gate.
