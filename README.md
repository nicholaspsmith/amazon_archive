# Amazon Order Hider

Amazon removed the ability to archive or hide orders. This restores it: a Hide
button on every order card, a toggle to reveal what you have hidden, and a popup
to unhide. Hidden orders are tracked by the ID in each card's
`data-csa-c-slot-id` attribute.

Personal-use extension for Firefox and Chrome. Not published to either store.

## Install

### Chrome

`chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
Chrome installs from the directory; no packaging step is involved.

### Firefox / Zen

Firefox has no "load unpacked" equivalent, and it will not permanently install an
add-on that is not signed. There are two routes:

**Testing — unsigned, removed when the browser restarts:**

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`extension/manifest.json`.

**Permanent — requires signing:**

```bash
npm run package   # builds dist/*.xpi and dist/*-chrome.zip
npm run sign      # signs via addons.mozilla.org, needs AMO API credentials
```

`npm run sign` submits to AMO on the `unlisted` channel, which signs the add-on
for self-distribution without publishing it to the public directory. Get API
credentials at https://addons.mozilla.org/developers/addon/api/key/ and export
them as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.

> **Do not build the archive by hand.** Compressing the `extension` folder — via
> Finder's "Compress" or `zip -r ext.zip extension` — nests every file under an
> `extension/` directory, so `manifest.json` is not at the archive root and
> Firefox rejects it with *"appears to be corrupt"*. `npm run package` zips from
> inside the directory and asserts the layout before it will emit an artifact.

Run `npm run lint:ext` to check the manifest with Mozilla's own linter.

## Sync (optional)

Hiding works entirely offline. To share the hidden list between browsers and
machines, deploy the Worker in [`worker/`](worker/README.md) and enter its URL
and token in the extension's Settings page.

## Develop

```bash
npm test          # node --test, no dependencies, no build step
```

Two module conventions live side by side:

- `extension/lib/*.js` (except `rules.js`), `background/`, `popup/`, `options/`,
  and `worker/src/` are ES modules with named exports.
- `extension/lib/rules.js` uses namespace assignment so it is valid **both** as a
  classic content script and as a side-effect ESM import. It must contain no
  `import`/`export` statements.

## Versioning

Currently **0.0.0**: written and unit-tested, but never loaded into a browser.

The version stays in `0.x` until [the manual verification
checklist](docs/manual-verification.md) passes end to end in both Chrome and
Firefox against a real order history page. Passing it is what earns **1.0.0** —
the unit tests cover the pure logic only, and say nothing about whether the
extension works.

`package.json` and `extension/manifest.json` carry the same number; bump both.

## Design

- **[Handoff — start here](docs/HANDOFF.md)** — current state, what is and isn't
  verified, next steps, and the traps
- [Design spec](docs/superpowers/specs/2026-08-13-amazon-order-hider-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-13-amazon-order-hider.md)
