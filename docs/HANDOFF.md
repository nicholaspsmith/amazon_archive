# Handoff — 2026-08-13

State of the work for whoever picks this up next. Read this first, then the
[design spec](superpowers/specs/2026-08-13-amazon-order-hider-design.md).

## Where things stand

**Version 0.0.0.** The extension loads in Zen (Gecko 153) as a temporary add-on
and hides orders. That is the extent of what has been confirmed in a browser.

The version stays in `0.x` until [the manual verification
checklist](manual-verification.md) passes end to end. Passing it earns `1.0.0`.
Bump both `package.json` and `extension/manifest.json` together.

### Confirmed working in a real browser

- Loads in Zen via `about:debugging` → Load Temporary Add-on.
- Hide buttons appear on order cards; hiding works.

### Written and unit-tested, never exercised in a browser

Everything else. 58 tests cover pure logic only — merge semantics, order-ID
parsing, CSS generation, the local store, and the Worker request handler. None of
them say whether the extension behaves correctly on a live page.

Specifically unverified: the reveal toggle, the popup, the options page, unhiding
from the popup, no-flash-on-reload, behavior across Amazon's pagination and year
filters, and every sync path.

### Not started

- **The Worker is undeployed.** `worker/wrangler.toml` still contains
  `REPLACE_WITH_NAMESPACE_ID`. Sync cannot be tested until it is deployed —
  see [worker/README.md](../worker/README.md).
- **The add-on is unsigned**, so it disappears on browser restart. `npm run sign`
  submits to AMO on the unlisted channel (signed for self-distribution, not
  published publicly) and needs API credentials from
  https://addons.mozilla.org/developers/addon/api/key/ exported as
  `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`. Worth checking first whether Zen
  honors `xpinstall.signatures.required = false` in `about:config`, which would
  let the unsigned `.xpi` install permanently with no AMO round trip.

## Next steps, in order

1. Reload the extension in Zen and confirm the Hide button now lands in the same
   corner on every card, including cancelled and digital orders, which have
   different card internals from delivered ones. This was just changed and is the
   one item with no browser confirmation at all.
2. Walk [docs/manual-verification.md](manual-verification.md) through the
   "Checklist" section. Report anything that fails rather than patching around it.
3. Deploy the Worker, then walk the "With sync configured" and "With sync broken"
   sections.
4. Decide on permanent installation (sign, or the `about:config` route above).
5. When the checklist passes clean, bump to 1.0.0.

## Open decisions for the user

- **`amazon-order-hider@nicholassmith`** — the Firefox add-on id in
  `extension/manifest.json` carries the user's name, and the repo is public. It is
  free to change *now*; after the add-on is installed, changing the id orphans its
  stored data in Firefox. The user was told and has not decided.

## Things that will bite you

- **The repo is public.** Never commit a real Amazon order ID. The history was
  rewritten once already to purge one. Placeholders in use throughout:
  `123-4567890-1234567` and `987-6543210-7654321`.
- **Never hand-build the archive.** Compressing the `extension` folder nests
  everything under `extension/`, leaving no `manifest.json` at the archive root,
  and Firefox rejects that as *"appears to be corrupt"*. Use `npm run package`,
  which zips from inside the directory and asserts the layout.
- **`manifest.json` goes to `about:debugging`, an `.xpi` goes to the Add-ons
  Manager.** Feeding a bare `manifest.json` to the Add-ons Manager also produces
  "appears to be corrupt". If a file picker makes you switch its filter to "All
  Files", you are in the wrong dialog.
- **Firefox's `chrome.*` is callback-based**; promises live on `browser.*`. Use
  `lib/api.js`, or in the content script the `ext` constant at the top of
  `content/orders.js`. Awaiting a bare `chrome.*` call silently yields `undefined`
  in Firefox — this already caused one bug where nothing was hidden at all.
- **`node --test test/` fails on Node 25** — it resolves the directory as an entry
  module. The test script uses a glob for this reason.
- **`extension/lib/rules.js` must contain no `import`/`export`.** It is loaded
  both as a classic content script and as a side-effect ESM import from tests and
  the popup, which is what keeps the pure DOM helpers testable with no build step.

## Commands

```bash
npm test          # 58 tests, no dependencies, no install needed
npm run lint:ext  # Mozilla's web-ext linter; expect 0 errors, 2 known warnings
npm run package   # builds dist/*.xpi and dist/*-chrome.zip, asserts layout
npm run sign      # signs via AMO, needs credentials above
```

The two expected lint warnings are `BACKGROUND_SERVICE_WORKER_IGNORED` (that key
is Chrome's, and one manifest deliberately serves both browsers) and the Firefox
for Android min-version notice (Android is not a target).

## Architecture in one paragraph

Cards are hidden by injecting CSS attribute-suffix rules at `document_start`, not
by removing DOM nodes — so hiding lands before first paint and keeps applying when
Amazon re-renders the list, with no observer racing the renderer. The
`MutationObserver` exists only to inject buttons into new cards. State is a
last-write-wins element set with tombstones, merged by identical code on the
client and in the Worker, so concurrent edits on two devices combine rather than
clobber. The background script is the single writer to `storage.local` and the
only caller of `fetch`; the content script and popup request changes by message
and re-render from `storage.onChanged`. `storage.local` is always the read path,
so the orders page never blocks on the network.
