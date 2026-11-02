# Registration wizard design QA

final result: passed

Source visual truth: `/root/.codex/generated_images/01a180ff-44af-7d12-b096-482f0028410b/exec-e7c47773-b374-4b6f-b37a-fb5c003d6c0b.png`.
Implementation: `.local/registration/approved-state-desktop.png`, `approved-state-card.png` and `comparison.png` in the same directory.

## Comparison and normalization

Opened both reference and browser-rendered captures, then inspected the combined `comparison.png`. Reference is 1174×1340 px, a standalone presentation card; cropped card approximately x129/y86/w916/h1168. Comparison scales that crop to 421px width. Implementation is a real split-page layout at 1440×1000 CSS px, deviceScaleFactor 1; card capture 421×641 px. Both show light theme, verified hello@example.com, password step, empty fields. This is an adaptive narrow-column comparison, not a claim of pixel-identical standalone framing. The combined capture itself is a focused, legible comparison of the entire registration card; the desktop and phone captures also cover full composition.

## Fidelity surfaces

- Typography: original product fonts retained, clear navy heading, spaced English kicker, quieter subtitle and field labels. Native 16px inputs intentionally stay larger than downscaled presentation lettering for readable/mobile-safe controls.
- Layout: large rounded cream card, progress rail, verified identity and edit link, password/confirmation, primary action, back link and split login/guest footer. Inline progress labels and a single-row identity summary are compact adaptations for the existing narrower right column; header and form hierarchy are retained. All actions remain reachable. Existing left-hand brand illustrations are unchanged.
- Palette: existing cream/navy/terracotta tokens, sage verified state; real light and dark CSS palettes inspected (skin override removed in test capture). No new illustration or logo is substituted.
- Assets/icons: genuine existing artwork and Lucide check/eye/arrow components; no rasterized forms, decorative placeholders or recreated illustration assets.
- Copy: approved two-step wording and password placeholder implemented. No separate password-rule paragraph or optional nickname. The approved “设置密码，至少12位” field label remains. Plain “以游客身份登录” is unboxed.

## Comparison history and fixes

1. Initial browser measurement caught desktop card change 569.6→606.7px. Shared minimum heights and tighter summary/feedback reserve resolved it.
2. Real-API responsive matrix caught 390×844 card transitions of 520–584.6px. The tall-phone shared card reserve is now 600px; shorter screens use the tested compact 500px layout. Recaptured matrix has zero height differences, overflow or clipped actions.
3. First theme capture had the existing starlight skin still overriding the light attribute. Corrected capture setup to remove that skin before light/dark checks; recaptured both themes and the exact verified-email state. This was a test-state mismatch, not a product theme change.

## Interactions and accessibility

Real browser: email verification including invalid OTP and proof reuse; username lookup/final creation; password confirmation errors; edit/back/login; plain guest entry. Focus moves to step heading, fields retain accessible labels, visibility controls expose pressed state, errors are announced. Current-method click is idempotent. Advisory name-check failures do not prevent final authoritative uniqueness validation.

16 viewport/theme combinations, each checking login/identity/password/error/back: 1920×900, 1366×768, 1280×640, 1280×600, 390×844, 390×700, 375×667, 320×640, light/dark. Browser page errors: none. Expected simulated 429/503 responses are covered by recovery tests, not concealed as successful network requests. Very short 320×400 windows retain natural scrolling; no document overflow hiding.

## Findings / release checklist

No remaining actionable P0/P1/P2 issues in the inspected states. No deferred P3 work required. Final production smoke used the same build: 18/18 desktop/phone/light/dark cases passed, browser exceptions zero. Live index and primary asset hashes matched the installed build; HTTPS health and both database integrity checks passed. No real account registration or SMTP sends in public smoke.
