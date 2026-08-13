# Amazon Order Hider — Design

**Date:** 2026-08-13
**Status:** Approved

## Problem

Amazon removed the ability to archive or hide orders from the order history page.
Every order you have ever placed is permanently visible in the list. This extension
restores hiding as a purely client-side feature: a Hide button on each order card,
a global toggle to reveal what is hidden, and a popup to unhide individual orders.

## Scope

**In scope**

- Firefox and Chrome, Manifest V3, loaded unpacked / self-signed for personal use.
- The order history list pages on `www.amazon.com`.
- Hiding and unhiding orders, persisted locally and mirrored to a private cloud store.
- A popup listing hidden orders, each unhideable.

**Out of scope**

- Publishing to the Chrome Web Store or AMO. This is a personal tool with a single
  user, which is what makes a single bearer token an acceptable credential model.
  Publishing would require per-user auth and is explicitly not being built.
- Order detail pages, "Buy Again", and any page other than the order list.
- Non-`.com` storefronts (`.co.uk`, `.ca`, `.de`, …). Adding them is a one-line
  change to the manifest match patterns if ever needed.
- Storing any order metadata beyond the ID — no dates, totals, titles, or images.
- Export/import of the hidden list.

## Audience and credential model

Single user, own browsers, loaded unpacked or self-signed. Anything shipped inside
an extension bundle is readable by anyone who installs it, so a single shared bearer
token is only defensible because there is exactly one installer. The token is never
committed to the repository; it is entered through the options page and stored in
`storage.local`.

---

## Architecture

```
amazon_archive/
├── extension/
│   ├── manifest.json
│   ├── content/
│   │   ├── orders.js            injects hide styles + buttons
│   │   └── orders.css
│   ├── background/
│   │   └── worker.js            all network I/O, sync orchestration
│   ├── lib/
│   │   ├── merge.js             pure LWW-set merge          ← unit tested
│   │   ├── orderId.js           pure slot-id → order id     ← unit tested
│   │   ├── store.js             storage.local read/write    ← unit tested
│   │   ├── cloud.js             Worker HTTP client
│   │   └── api.js               browser/chrome namespace shim
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   └── options/
│       ├── options.html
│       └── options.js
├── worker/
│   ├── src/index.js             Cloudflare Worker
│   ├── src/merge.js             shared copy of lib/merge.js
│   └── wrangler.toml
├── test/
│   ├── merge.test.js
│   ├── orderId.test.js
│   ├── store.test.js
│   └── worker.test.js
└── docs/
    ├── superpowers/specs/
    └── manual-verification.md
```

### Component responsibilities

| Unit | Does | Depends on |
|---|---|---|
| `lib/merge.js` | Pure functions `merge(a, b)` and `prune(state, now)`. No I/O, no globals. | nothing |
| `lib/orderId.js` | Pure `orderIdFromSlotId(str)`, returns `null` for non-matching input. | nothing |
| `lib/store.js` | Reads/writes the local state blob; applies `merge` on inbound cloud state. | `merge`, `api` |
| `lib/cloud.js` | `sync(state)` and `list()` against the Worker. Throws typed errors. | `api` |
| `content/orders.js` | Owns the DOM: injects the style element, the per-card buttons, the reveal toggle. Never touches the network. | `store`, `orderId` |
| `background/worker.js` | The only network caller. Owns sync triggers, backoff, and messaging. | `store`, `cloud` |
| `popup/popup.js` | Renders hidden list from local state, sends unhide and refresh messages to the background. Does no network I/O of its own. | `store`, `api` |

The content script performs no network I/O. In MV3 a content script's `fetch` is
CORS-checked against the host page's origin (`amazon.com`) rather than being granted
the extension's host permissions, so routing all requests through the background
avoids that problem and gives the popup and content script one shared sync path.

### Cross-browser namespace

Chrome exposes promise-returning `chrome.*` under MV3; Firefox exposes
promise-returning `browser.*`. `lib/api.js` resolves this once:

```js
export const api = globalThis.browser ?? globalThis.chrome;
```

All other modules import `api` and use promises. No callback style anywhere.

---

## Hiding mechanism

Order cards are identified by the attribute given in the live page:

```html
<div class="order-card js-order-card"
     data-csa-c-type="widget"
     data-csa-c-content-id="amzn1.yourorders.order-card"
     data-csa-c-slot-id="amzn1.yourorders.order-card.123-4567890-1234567"
     data-csa-c-id="examp1-exampl-exampl-ex4mp1">
```

The order ID is everything after the final `.` in `data-csa-c-slot-id`. This is
unambiguous because order IDs use `-` as their internal separator. Note that
`data-csa-c-content-id` carries the same prefix *without* an ID and must not match;
`orderIdFromSlotId` requires a non-empty segment after the prefix and returns `null`
otherwise.

### Cards are hidden with CSS, not removed from the DOM

The content script maintains one `<style>` element containing an attribute-suffix
rule per hidden ID:

```css
[data-csa-c-slot-id$=".123-4567890-1234567"],
[data-csa-c-slot-id$=".987-6543210-7654321"] { display: none !important; }

html.aa-reveal [data-csa-c-slot-id$=".123-4567890-1234567"],
html.aa-reveal [data-csa-c-slot-id$=".987-6543210-7654321"] {
  display: block !important;
  opacity: .45;
  outline: 1px dashed #888;
}
```

Rationale for CSS over DOM removal:

1. **No flash of unhidden orders.** The script runs at `document_start` and
   `storage.local` resolves in about a millisecond, so the rule is in place well
   before Amazon paints the order list.
2. **Survives Amazon's own re-rendering.** Pagination, filter changes, and lazy
   loading all replace list DOM. A removal-based approach has to run a
   `MutationObserver` that races Amazon's renderer and re-removes cards after every
   update. Style rules keyed on an attribute apply automatically to any card that
   appears later, so hiding is never in a race.
3. **Reveal is a single class toggle** on `documentElement`, not a re-render.

A `MutationObserver` is still required, but only to inject the Hide button into
newly-appeared cards — a job where a brief delay is harmless.

At `document_start` `document.head` may not exist yet, so the style element is
appended to `document.documentElement`.

### Injected UI

- **Per-card Hide button.** A small button in the card's header row. The exact
  header selector inside `.order-card` must be confirmed against the live page
  during implementation; if no stable header element exists, the fallback is
  `position: absolute` in the card's top-right corner with `position: relative` on
  the card. Buttons are marked with a data attribute so the observer never
  double-injects. When the reveal toggle is on, a hidden card's button reads
  "Unhide" instead.
- **Reveal toggle.** A `Show hidden (n)` control injected at the top of the order
  list, rendered only when `n > 0`. Toggling adds/removes `aa-reveal` on
  `documentElement`. The reveal state is per-page-load and is not persisted.

Styling uses a `aa-` class prefix throughout to avoid collision with Amazon's CSS.

---

## Data model

State is a last-write-wins element set:

```json
{
  "version": 1,
  "orders": {
    "123-4567890-1234567": { "hidden": true,  "ts": 1755100000000 },
    "987-6543210-7654321": { "hidden": false, "ts": 1755200000000 }
  }
}
```

`ts` is `Date.now()` at the moment of the hide or unhide.

A plain `["id1", "id2"]` array would lose edits across devices: hide an order on the
laptop while the desktop is offline, and whichever syncs second overwrites the other
wholesale. Per-ID timestamps make the merge commutative and idempotent, so both
edits survive.

Entries with `hidden: false` are **tombstones**, retained rather than deleted. Without
them, an unhide is indistinguishable from "never hidden", and a device holding stale
state would resurrect the order on its next sync.

### Merge and prune

```
merge(a, b):
  for each key in union(a.orders, b.orders):
    pick the entry with the greater ts
    on exact tie, hidden: true wins  (deterministic, order-independent)

prune(state, now):
  drop entries where hidden === false and now - ts > 90 days
```

`merge` must be commutative, associative, and idempotent — these are the properties
the tests assert. `prune` runs on write, not on read, so pruning is never observable
mid-merge.

If an incoming state carries a `version` greater than the one this build knows, the
extension refuses to merge, keeps local state untouched, and surfaces a
"newer data format" error in the popup. This prevents a future schema from being
silently flattened by an older install.

---

## Sync

### Protocol

```
POST /sync    Authorization: Bearer <token>
              { "version": 1, "orders": { … } }
           →  200 { "version": 1, "orders": { …merged… } }

GET  /list    Authorization: Bearer <token>
           →  200 { "version": 1, "orders": { … } }
```

`POST /sync` means "here is my state, return the union". The Worker runs the same
merge function server-side, so two devices writing concurrently cannot clobber each
other, and a full sync costs one round-trip. `GET /list` exists for read-only paths
(popup open) so they do not consume a KV write.

### Triggers

| Trigger | Call |
|---|---|
| Orders page load | `POST /sync` |
| Hide / unhide | `POST /sync`, debounced 2s |
| Popup open | `GET /list` |
| `alarms` every 30 min | `POST /sync` |

Every row is initiated by the background script. The popup and content script request
a sync by message; neither calls `fetch`.

After any successful call the merged state is written locally, and the background
messages any open orders tab to refresh its style rules and toggle count.

### Worker

Cloudflare Worker over KV. KV binding `ORDERS`, single key `orders:v1`, since there
is one user. The bearer token is a Worker secret (`AUTH_TOKEN`), compared with a
timing-safe equality check rather than `===` to avoid leaking length or prefix
information through response timing. Unauthenticated requests get `401` with no body.

If a `POST /sync` body carries a `version` the Worker does not know, it responds
`409` and leaves stored state untouched, mirroring the extension-side rule: an older
participant must never flatten a newer schema.

The Worker handles `OPTIONS` preflight and returns
`Access-Control-Allow-Origin: *`. A wildcard origin is safe here because the bearer
token, not the origin, is the access control.

KV is eventually consistent with global propagation up to ~60 seconds. For a single
user this is invisible; in the worst case a second device sees a stale list for under
a minute and the next merge reconciles it without data loss.

Free tier limits (100k KV reads/day, 1k writes/day, 100k Worker requests/day) exceed
realistic usage by orders of magnitude. Unlike Supabase's free tier, a Worker never
pauses for inactivity.

### Host permission

The Worker URL is user-supplied, so it cannot be a static `host_permissions` entry.
The manifest declares `optional_host_permissions: ["https://*/*"]`, and the options
page calls `permissions.request({ origins: [<worker origin>/*] })` when the URL is
saved. This yields one grant prompt at setup and no broad standing permission.

---

## Failure handling

Local state is always the read path for rendering. The orders page never blocks on,
waits for, or shows a spinner for the network.

| Condition | Behavior |
|---|---|
| No token / URL configured | Extension works fully, locally. Popup shows a "Not connected — set up sync" link to options. |
| Worker unreachable, timeout, 5xx | Local state unaffected. Popup shows last-synced time and an error indicator. Retry on the next natural trigger with exponential backoff (2s, 4s, 8s, capped at 5 min). |
| `401` | Popup shows "Authentication failed — check your token". No retry until settings change. |
| Incoming `version` too new | Local state untouched; popup shows a format-mismatch error. |

Sync metadata (`lastSyncAt`, `lastError`) lives in `storage.local` alongside state.

---

## Testing

`node --test` with no dependencies. Coverage concentrates on the pure logic, where
the failure modes are real and silent:

**`merge.test.js`**
- commutativity, associativity, idempotence on generated pairs
- concurrent hide on A and unhide on B, both orderings, higher `ts` wins
- exact `ts` tie resolves to `hidden: true` regardless of argument order
- tombstone is not dropped by a merge with state that lacks the key
- `prune` boundary: exactly 90 days is kept, 90 days plus a millisecond is dropped
- `prune` never drops `hidden: true` regardless of age
- incoming `version` greater than known throws rather than merging

**`orderId.test.js`**
- well-formed slot ID yields the ID
- `data-csa-c-content-id` value (`amzn1.yourorders.order-card`, no trailing ID)
  returns `null` — the important negative case
- empty string, `null`, unrelated attribute values, and a trailing `.` return `null`

**`store.test.js`**
- round-trip through a fake `storage.local`
- inbound cloud state is merged, not overwritten

**`worker.test.js`**
- against `wrangler dev`: missing token → 401, wrong token → 401, valid `POST /sync`
  returns the merged union, `GET /list` does not mutate stored state, `OPTIONS`
  returns CORS headers

DOM injection and live-page behavior are covered by a written checklist in
`docs/manual-verification.md` rather than a headless-browser harness, which would be
brittle against a page whose markup Amazon changes without notice. The checklist
covers: hide a card, reload and confirm it stays hidden with no visible flash,
toggle reveal, unhide from the popup, unhide in place while revealed, paginate to
page 2 and confirm hiding still applies, and confirm the page behaves normally with
sync misconfigured.

---

## Security and secrets

- The bearer token is entered in the options page and stored in `storage.local`.
  It never appears in the repository, the manifest, or any committed file.
- `.gitignore` covers `.dev.vars`, `.wrangler/`, and `node_modules/`.
- The Worker's `wrangler.toml` contains the KV namespace ID and no secrets; the
  token is set via `wrangler secret put AUTH_TOKEN`.
- The only data leaving the machine is a set of Amazon order IDs and timestamps.
  No product names, prices, addresses, or images are collected or transmitted.

## Manifest notes

Single manifest serving both browsers. It declares both `background.service_worker`
(Chrome) and `background.scripts` (Firefox); each browser warns about and ignores the
other's key. Firefox additionally requires `browser_specific_settings.gecko.id` and a
`strict_min_version` of `121.0`, the first release with usable MV3 support.

Permissions: `storage`, `alarms`, `optional_host_permissions: ["https://*/*"]`.

Content script matches, all at `document_start`:

```
*://www.amazon.com/gp/your-account/order-history*
*://www.amazon.com/gp/css/order-history*
*://www.amazon.com/your-orders/orders*
```

## Open item for implementation

The header element inside `.order-card` that the Hide button attaches to is not yet
known — the available markup sample covers only the card's opening tag. This must be
confirmed against the live orders page before the button injection is written, with
the absolute-positioning fallback described above if no stable header exists.
