# Issue 69 — `ai-dungeon-master` embeds the user's API key in every generated image URL: page DOM, saved games and access logs

- **Severity:** Medium-High (credential disclosure of a spend-capable `sk_` key; platform precedent: the identical defect class was fixed for catgpt in #18754 with a regression test)
- **Affected:** `apps/ai-dungeon-master/src/App.tsx` — `&key=${apiKey}` appended at :383 (scene), :395 (fallback), :407 (avatar), :659 (inventory item); the URLs become canonical state rendered as `<img src>` (`SceneArea.tsx:29-30`, `GalleryModal.tsx:165,259`, `StoryHistory.tsx:112`, `InventoryGrid.tsx:44`) and persisted indefinitely via `localStorage.setItem("rpgGameState", …)` (`App.tsx:227`, plain-save path keeps key-bearing URLs) — upstream `pollinations/pollinations` main @ `52fd0a6c82` (2026-11-18)
- **Fix branch:** `solution58-dungeon-master-key-out-of-urls` — **PR:** [#81](https://github.com/NamanSoni78/pollinationsai/pull/81)
- **Relationships:** the platform's own fix for the identical class is upstream commit `2d22281760` (#18754, catgpt: "The key goes in the Authorization header, never the URL, so it stays out of the page, saved memes and access logs"). Issue 18 covered catgpt-*bot* ungated spend — a different defect. Not otherwise filed.

## Root cause

`fetchImage` / `generateFallbackImage` / `fetchCharacterAvatar` / `fetchItemImage` authenticate the gen image endpoint by appending the user's `sk_` key as a URL query parameter (`?key=`), because `<img>` tags cannot send headers. The returned URL string then becomes the app's persistent state:

1. the full key sits in the page DOM on every `<img>` (scene, gallery, history, inventory) — readable by any script on the origin;
2. "copy image address" / sharing a scene URL hands over a **working credential** (gen accepts `?key=` as a full API-key credential, `shared/auth/api-key.ts:192-208`, whose own comment warns "Query keys end up in access logs, referrers and browser history");
3. the key is persisted in `localStorage.rpgGameState` indefinitely — in `currentScene.image`, `storyHistory[].image`, `inventory[].image`, `character.avatar` — directly contradicting `useAuth.ts:7` ("Use sessionStorage to avoid persisting credentials beyond the browser session").

## Fix (ports the catgpt #18754 pattern)

- new `src/utils/imageUrls.ts`: `buildImageUrl` (keyless URL builder), `fetchAuthorizedImage` (key in the `Authorization` header → `blob:` object URL for display), `persistableImage` (only an uploaded `media.pollinations.ai` URL — or empty — is a lasting reference worth saving);
- all four image functions fetch with the header and display via object URLs;
- saves (both "Save Only" and "Upload & Save") persist only persistable images; keyed and `blob:` URLs are never written;
- keyed URLs from older saves are dropped on load (story text and structure kept; the catgpt `getSavedMemes` filter doctrine).

## Tests

4 new tests in `apps/ai-dungeon-master/src/utils/imageUrls.test.ts`, mirroring catgpt's regression test: keyless URL builder; `fetchImage`-style call carries the key in the `Authorization` header and never in the URL; persistence filter refuses keyed and `blob:` URLs while keeping media URLs; legacy keyed-URL detection. `npm test` **4/4**, `tsc -b` clean.

## Notes

- The deployed app's behavior change: images no longer survive a page reload unless the user chose "Upload & Save" (which uploads to media and persists the lasting URL) — the deliberate catgpt trade-off ("only a published image has a lasting URL worth saving"); the save dialog already explains "Images will be stored permanently" for that path.
- Below-gate observations from the same audit of the 12-app fleet (recorded, not filed): `map-to-isometric`/`reimagine` upload user images to public ImgBB; `virtual-makeup` publishes user photos + results to the public media host by design; the Roblox templates' in-flight gate has no cooldown (no platform secret in their deployment path, so no finding).
