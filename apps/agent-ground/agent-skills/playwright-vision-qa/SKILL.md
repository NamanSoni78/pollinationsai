---
name: playwright-vision-qa
description: Audit rendered desktop (1440px) and mobile (390px) viewports for layout overflow, contrast, and runtime console errors.
required_tools: [ground_request_peer_check, publish_smoke_test]
---
# Playwright & Vision QA Skill

1. Launch headless Chromium against the preview URL at 1440x900 desktop and 390x844 mobile viewports.
2. Verify zero uncaught page exceptions, zero failed API requests, and zero horizontal overflow on mobile.
3. Inspect screenshots via the Pollinations Vision model role (`openai/gpt-5.4-mini`) to confirm contrast, alignment, and absence of overlapping panels.
4. Before spending Warden budget, optionally invoke `ground_request_peer_check` so a peer agent validates integration endpoints.
