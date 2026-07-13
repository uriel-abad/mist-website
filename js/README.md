# MIST data-driven website

The product catalogue is now controlled by `data/products.json`. You do not need to edit `index.html`, `styles.css`, or the JavaScript whenever you add a normal product.

## Previewing the website

Because browsers block `fetch()` from local `file://` pages, do not open `index.html` by double-clicking it. Run a small local web server instead.

### VS Code
Install the **Live Server** extension, right-click `index.html`, then select **Open with Live Server**.

### Python
Open a terminal inside this folder and run:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Adding a new product

1. Create a product folder:

```text
images/products/sculpt-shorts/
```

2. Add one folder per color:

```text
images/products/sculpt-shorts/black/front.png
images/products/sculpt-shorts/black/back.png
images/products/sculpt-shorts/sage/front.png
images/products/sculpt-shorts/sage/back.png
```

3. Open `data/products.json` and add another object after the current product. Remember to place a comma between product objects.

```json
{
  "id": "sculpt-shorts",
  "name": "AirForm Sculpt Shorts",
  "price": 699,
  "badge": "NEW",
  "sizes": ["XS", "S", "M", "L", "XL"],
  "defaultColor": "Black",
  "colors": {
    "Black": {
      "front": "images/products/sculpt-shorts/black/front.png",
      "back": "images/products/sculpt-shorts/black/back.png"
    },
    "Sage": {
      "front": "images/products/sculpt-shorts/sage/front.png",
      "back": "images/products/sculpt-shorts/sage/back.png"
    }
  }
}
```

The website automatically creates the product card, color selector, size selector, hover image, order-list controls, and order payload.

## Files

- `index.html` — page structure only
- `css/styles.css` — website design
- `data/products.json` — product names, prices, sizes, colors, and image paths
- `js/config.js` — Apps Script URL and product-data location
- `js/ui.js` — product and interface rendering
- `js/cart.js` — order-list logic
- `js/app.js` — loading, events, and order submission
- `images/products/` — product image folders

## Important

Keep every product `id` unique and use lowercase folder-friendly names such as `airform-studio-set` or `sculpt-shorts`.

## Navigation and section sizing

The sticky navigation height is measured automatically in `js/app.js`. Anchor links use that value so section headings are not hidden beneath the navigation bar. On desktop, the Collections, Size Guide, How to Order, Order List, and Order Request sections have a minimum height equal to the visible browser viewport. On smaller screens, these sections return to natural height so content is not cramped.

## Monochrome UI update
This version uses a black, white, and light-grey palette. The Shopping Bag section now uses a white card with a subtle border and shadow so it matches the rest of the storefront.

## Catalogue layout

The catalogue uses a fixed four-column desktop grid. A single product stays at normal catalogue-card width rather than stretching across the page. As more entries are added to `data/products.json`, they automatically fill the remaining columns.
