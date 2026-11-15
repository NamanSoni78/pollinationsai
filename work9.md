# Work 9 — Pollen Towers (Quest #17999)

**Quest:** [Build your own tower of AI-run companies](https://github.com/pollinations/pollinations/issues/17999)
**Branch:** `work9-pollen-towers`
**Live:** <https://pollentowers.edgeone.cool>
**App key:** `pk_HoExZJIrsjeK3i46`

## Goal

Your own version of Towers: a building where every floor is one business run by one person and their AI agents. The agents do the daily work and bring finished jobs to the owner for decisions that need a human; visitors turn the tower, browse the directory, and rent the next office.

## Research notes

- Towers (thetowers.ai → towers.app): 112 companies across 4 towers; "describe your business or paste a link" is the onboarding; each floor gets its own page; a public directory doubles as discovery and social proof; meta-services (FloorSync, Next Friend, Shellbody) serve other floors — emergent ecosystem depth.
- Pollinations agents run on the caller's Pollen — here, BYOP keys make every visitor's agents run on their own balance.

## What was built

- a rotatable 3D-ish tower (CSS 3D transforms) with 30 floors: lobby, seed companies on the lower floors, rentable offices going up
- **founder flow:** name your company, one-line pitch → your agents (a Pollinations model persona per role: researcher, marketer, ops) generate the company profile, a product plan, a launch post, and a daily standup report — all on your Pollen
- **agent standups:** each floor's agents can be "run": they produce that day's work (research brief, outreach draft, changelog) and a decision card for the human owner to approve/redirect
- **directory:** browsable list of all companies in the tower with search + category filters; click a floor to open its office page
- **rent flow:** visitors rent the next empty office and become a founder themselves (state in localStorage, seeded demo companies pre-populated)
- economy layer: each standup shows its Pollen cost estimate
- BYOP via `<polli-connect app-key="pk_HoExZJIrsjeK3i46">`
- Made with pollinations.ai badge

## Verification

- [x] tower renders and rotates; floors clickable
- [x] founder onboarding generates a company profile end to end
- [x] agent standup produces research/marketing/ops artifacts + decision card
- [x] directory lists companies, search filters work
- [x] rent flow places a new company on the next floor
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Deployment

- EdgeOne Pages project `pollentowers`, production deploy verified HTTP 200
- headless test: 30 floors render (lobby + 7 seeded + 22 rentable), directory lists 7, search and category filters work, office panel complete, drag rotation live, no-key rent guard fires, zero JS errors

## Outcome

Shipped as quest submission for #17999.
