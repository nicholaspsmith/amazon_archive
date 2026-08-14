# Amazon Order Hider

Amazon removed the ability to archive or hide orders. This restores it: a Hide
button on every order card, a toggle to reveal what you have hidden, and a popup
to unhide. Hidden orders are tracked by the ID in each card's
`data-csa-c-slot-id` attribute.

Personal-use extension for Firefox and Chrome. Not published to either store.

## Install

Load `extension/` unpacked — see [docs/manual-verification.md](docs/manual-verification.md).

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

- [Design spec](docs/superpowers/specs/2026-08-13-amazon-order-hider-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-13-amazon-order-hider.md)
