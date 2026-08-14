# Manual verification

Automated tests cover the pure logic. This checklist covers what only a real
order history page can exercise. Run it after any change to the content script,
the manifest, or the popup.

## Load the extension

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `extension/manifest.json`.

## Checklist

- [ ] Open `https://www.amazon.com/gp/your-account/order-history`. Every order card shows a **Hide** button.
- [ ] Click Hide on one card. The card disappears immediately and a **Show hidden orders (1)** control appears above the list.
- [ ] Reload the page. The card is still hidden, and it never flashes visible during load. Watch closely — a flash means the `document_start` fast path regressed.
- [ ] Click **Show hidden orders (1)**. The card reappears dimmed with a dashed outline, and its button now reads **Unhide**.
- [ ] Click **Unhide** on the revealed card. It returns to normal and the toggle disappears.
- [ ] Hide three orders, then open the popup. All three IDs are listed, most recent first.
- [ ] Click an ID in the popup. It opens that order's detail page in a new tab.
- [ ] Click **Unhide** in the popup with the orders page open behind it. The card reappears on the page without a reload.
- [ ] Hide an order, then use Amazon's own pagination to go to page 2 and back. The order is still hidden and buttons are present on the new page's cards.
- [ ] Change the year filter. Hiding still applies and buttons appear on the re-rendered cards.

## With sync configured

- [ ] Open Settings, enter the Worker URL and token, click Save. It reports how many hidden orders are on the server.
- [ ] Hide an order in Chrome, wait ~5 seconds, then open the orders page in Firefox. The same order is hidden there.
- [ ] Unhide it in Firefox, reload in Chrome. It is visible again — the tombstone propagated rather than the older hide winning.

## With sync broken

- [ ] Enter a wrong token in Settings. The page reports the failure.
- [ ] Reload the orders page. Hiding still works normally and the page shows no error or delay.
- [ ] The popup footer reads `Sync failed — AuthError: …`.
- [ ] Clear the Worker URL. The popup footer reads `Sync not set up` and hiding still works.
