# MIST website — SKU catalog version

## Google Apps Script setup
1. Open the new Google Sheet, then **Extensions → Apps Script**.
2. Replace all contents of `Code.gs` with the included `Code.gs`.
3. Save and run `setupMistBackend()` once.
4. The script creates `Products`, `Orders`, `Order Items`, and `Inventory`.
5. Enter real quantities only in the **Stock** column of `Inventory`. Do not manually change Reserved or Available.
6. Deploy as a Web App: execute as **Me**, access **Anyone**.
7. Copy the `/exec` URL into `js/config.js` as `gasEndpoint`.

## SKU reference
- White: `AFS-WHT-XS` through `AFS-WHT-XL`
- Black: `AFS-BLK-XS` through `AFS-BLK-XL`
- Light Pink: `AFS-PNK-XS` through `AFS-PNK-XL`

The website sends SKU and quantity. The backend reads official names and prices from the Products sheet.
