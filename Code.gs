/**
 * MIST SKU-BASED ORDER BACKEND
 *
 * Sheets:
 *   Products    — official product catalog and prices (single source of truth)
 *   Orders      — one row per customer order
 *   Order Items — one row per ordered SKU
 *   Inventory   — stock, reserved, and available quantity per SKU
 *
 * Inventory workflow:
 *   New / Suspicious / Duplicate / Cancelled = no inventory held
 *   Confirmed / Packed                       = inventory reserved
 *   Shipped / Delivered                      = inventory deducted
 *
 * Run setupMistBackend() once after pasting this script.
 */

const ORDER_PREFIX = "MIST";
const FIRST_ORDER_NUMBER = 1;
const DUPLICATE_WINDOW_MINUTES = 30;
const SPREADSHEET_PROPERTY_KEY = "MIST_SPREADSHEET_ID";

const PRODUCTS_SHEET_NAME = "Products";
const ORDERS_SHEET_NAME = "Orders";
const ITEMS_SHEET_NAME = "Order Items";
const INVENTORY_SHEET_NAME = "Inventory";

const ORDER_STATUSES = [
  "New", "Suspicious", "Confirmed", "Packed", "Shipped",
  "Delivered", "Cancelled", "Duplicate"
];
const PAYMENT_STATUSES = ["Pending", "Paid", "COD", "Refunded"];

const PRODUCT_HEADERS = [
  "Product ID", "SKU", "Product Name", "Color", "Size", "Price", "Active"
];
const ORDER_HEADERS = [
  "Submitted At", "Order Number", "Customer Name", "Email", "Mobile",
  "Delivery Address", "Total Quantity", "Subtotal", "Status",
  "Payment Status", "Duplicate Check", "Inventory State", "Notes",
  "Order Signature"
];
const ITEM_HEADERS = [
  "Submitted At", "Order Number", "Product ID", "SKU", "Product Name",
  "Color", "Size", "Quantity", "Unit Price", "Line Total"
];
const INVENTORY_HEADERS = [
  "SKU", "Product Name", "Color", "Size", "Stock", "Reserved", "Available"
];

const DEFAULT_CATALOG = (() => {
  const rows = [];
  const sizes = ["XS", "S", "M", "L", "XL"];
  const colors = [
    { name: "White", code: "WHT" },
    { name: "Black", code: "BLK" },
    { name: "Light Pink", code: "PNK" }
  ];
  colors.forEach(color => sizes.forEach(size => rows.push([
    "AFS",
    `AFS-${color.code}-${size}`,
    "AirForm Studio Set",
    color.name,
    size,
    899,
    "Yes"
  ])));
  return rows;
})();

function doGet() {
  return jsonResponse_({ ok: true, message: "MIST SKU order endpoint is running." });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const payload = parsePayload_(e);
    validateCustomer_(payload);

    const spreadsheet = getSpreadsheet_();
    const sheets = prepareSheets_(spreadsheet);

    // Defensive initialization: the live endpoint can recover even if setup was
    // not run after a fresh deployment. Existing rows and stock are preserved.
    seedDefaultCatalog_(sheets.products);
    syncInventoryFromProducts_(sheets.products, sheets.inventory);

    const catalog = productCatalogMap_(sheets.products);
    const items = validateAndPriceItems_(payload.items, catalog);

    const submittedAt = new Date();
    const orderNumber = nextOrderNumber_();
    const totalQuantity = items.reduce((sum, item) => sum + item.qty, 0);
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const signature = orderSignature_(payload, items);
    const duplicateOrder = findLikelyDuplicate_(sheets.orders, payload, signature, submittedAt);

    sheets.orders.appendRow([
      submittedAt,
      orderNumber,
      payload.name.trim(),
      payload.email.trim(),
      payload.mobile.trim(),
      payload.address.trim(),
      totalQuantity,
      subtotal,
      duplicateOrder ? "Suspicious" : "New",
      "Pending",
      duplicateOrder ? "Possible duplicate of " + duplicateOrder : "Clear",
      "NONE",
      String(payload.notes || "").trim(),
      signature
    ]);

    const itemRows = items.map(item => [
      submittedAt, orderNumber, item.productId, item.sku, item.name,
      item.color, item.size, item.qty, item.unitPrice, item.lineTotal
    ]);
    const firstItemRow = sheets.items.getLastRow() + 1;
    sheets.items.getRange(firstItemRow, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);

    ensureInventoryRows_(sheets.inventory, items);
    formatNewOrderRow_(sheets.orders, sheets.orders.getLastRow());
    formatNewItemRows_(sheets.items, firstItemRow, itemRows.length);
    SpreadsheetApp.flush();

    return jsonResponse_({
      ok: true,
      orderNumber,
      totalQuantity,
      subtotal,
      possibleDuplicate: Boolean(duplicateOrder)
    });
  } catch (error) {
    console.error(error);
    return jsonResponse_({ ok: false, error: String(error && error.message || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/** Run this once from the spreadsheet-bound Apps Script editor. */
function setupMistBackend() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Open Apps Script from the Google Sheet using Extensions → Apps Script.");
  }
  PropertiesService.getScriptProperties().setProperty(SPREADSHEET_PROPERTY_KEY, spreadsheet.getId());
  const sheets = prepareSheets_(spreadsheet);
  seedDefaultCatalog_(sheets.products);
  syncInventoryFromProducts_(sheets.products, sheets.inventory);
  formatAllSheets_(sheets);
  SpreadsheetApp.flush();
  return "MIST backend is ready: Products, Orders, Order Items, and Inventory.";
}

/** Alias retained for convenience. */
function setupOrderSheets() {
  return setupMistBackend();
}

/** Add missing catalog SKUs to Inventory without changing existing stock. */
function syncInventoryFromProducts() {
  const ss = getSpreadsheet_();
  const sheets = prepareSheets_(ss);
  const added = syncInventoryFromProducts_(sheets.products, sheets.inventory);
  formatInventorySheet_(sheets.inventory);
  SpreadsheetApp.flush();
  return added + " inventory row(s) added.";
}

/** Automatically manages inventory when Status (column I) is edited. */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== ORDERS_SHEET_NAME || e.range.getRow() < 2 || e.range.getColumn() !== 9 || e.range.getNumRows() !== 1) return;

  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(30000);
    const newStatus = String(e.value || "").trim();
    const oldStatus = String(e.oldValue || "New").trim();
    if (!ORDER_STATUSES.includes(newStatus)) return;

    const row = e.range.getRow();
    const orderNumber = String(sheet.getRange(row, 2).getValue()).trim();
    const currentState = String(sheet.getRange(row, 12).getValue() || "NONE").trim();
    const targetState = inventoryStateForStatus_(newStatus);

    if (currentState === "SOLD" && targetState !== "SOLD") {
      e.range.setValue(oldStatus);
      e.source.toast("Stock was already deducted. Handle a return manually before changing this status.", "MIST", 10);
      return;
    }
    if (currentState === targetState) return;

    const itemsSheet = e.source.getSheetByName(ITEMS_SHEET_NAME);
    const inventorySheet = e.source.getSheetByName(INVENTORY_SHEET_NAME);
    const items = getOrderItems_(itemsSheet, orderNumber);
    transitionInventory_(inventorySheet, items, currentState, targetState);
    sheet.getRange(row, 12).setValue(targetState);
    e.source.toast(`Order ${orderNumber}: inventory ${targetState}`, "MIST", 6);
  } catch (error) {
    try {
      e.range.setValue(e.oldValue || "New");
      e.source.toast(String(error && error.message || error), "MIST inventory update failed", 10);
    } catch (_) {}
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function inventoryStateForStatus_(status) {
  if (status === "Confirmed" || status === "Packed") return "RESERVED";
  if (status === "Shipped" || status === "Delivered") return "SOLD";
  return "NONE";
}

function transitionInventory_(sheet, items, fromState, toState) {
  if (!items.length) throw new Error("No order items were found.");
  if (fromState === "NONE" && toState === "RESERVED") return adjustInventory_(sheet, items, 0, 1);
  if (fromState === "RESERVED" && toState === "NONE") return adjustInventory_(sheet, items, 0, -1);
  if (fromState === "RESERVED" && toState === "SOLD") return adjustInventory_(sheet, items, -1, -1);
  if (fromState === "NONE" && toState === "SOLD") return adjustInventory_(sheet, items, -1, 0);
  throw new Error(`Unsupported inventory transition: ${fromState} to ${toState}`);
}

function adjustInventory_(sheet, items, stockMultiplier, reservedMultiplier) {
  if (!sheet) throw new Error("Inventory sheet was not found.");
  const map = inventoryMap_(sheet);
  const combined = combineSkuItems_(items);
  const changes = [];

  combined.forEach(item => {
    const record = map[item.sku.toUpperCase()];
    if (!record) throw new Error("SKU is missing from Inventory: " + item.sku);
    const stock = Number(record.values[4] || 0);
    const reserved = Number(record.values[5] || 0);
    const newStock = stock + stockMultiplier * item.quantity;
    const newReserved = reserved + reservedMultiplier * item.quantity;
    const newAvailable = newStock - newReserved;
    if (newStock < 0) throw new Error("Not enough stock for " + item.sku + ".");
    if (newReserved < 0) throw new Error("Reserved quantity cannot be negative for " + item.sku + ".");
    if (newAvailable < 0) throw new Error("Not enough available stock for " + item.sku + ".");
    changes.push({ row: record.row, stock: newStock, reserved: newReserved, available: newAvailable });
  });

  changes.forEach(c => sheet.getRange(c.row, 5, 1, 3).setValues([[c.stock, c.reserved, c.available]]));
}

function prepareSheets_(spreadsheet) {
  const products = prepareSheet_(spreadsheet, PRODUCTS_SHEET_NAME, PRODUCT_HEADERS, "Products Legacy");
  const orders = prepareSheet_(spreadsheet, ORDERS_SHEET_NAME, ORDER_HEADERS, "Orders Legacy");
  const items = prepareSheet_(spreadsheet, ITEMS_SHEET_NAME, ITEM_HEADERS, "Order Items Legacy");
  const inventory = prepareSheet_(spreadsheet, INVENTORY_SHEET_NAME, INVENTORY_HEADERS, "Inventory Legacy");
  return { products, orders, items, inventory };
}

function prepareSheet_(spreadsheet, name, headers, legacyBase) {
  let sheet = spreadsheet.getSheetByName(name);
  if (sheet && sheet.getLastRow() > 0 && !headersMatch_(sheet, headers)) {
    sheet.setName(uniqueSheetName_(spreadsheet, legacyBase));
    sheet = null;
  }
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function seedDefaultCatalog_(sheet) {
  if (sheet.getLastRow() > 1) return;
  sheet.getRange(2, 1, DEFAULT_CATALOG.length, PRODUCT_HEADERS.length).setValues(DEFAULT_CATALOG);
}

function syncInventoryFromProducts_(productsSheet, inventorySheet) {
  const catalog = productCatalogMap_(productsSheet);
  const inventory = inventoryMap_(inventorySheet);
  const missing = [];
  Object.keys(catalog).sort().forEach(sku => {
    const p = catalog[sku];
    if (p.active && !inventory[sku]) missing.push([p.sku, p.name, p.color, p.size, 0, 0, 0]);
  });
  if (missing.length) inventorySheet.getRange(inventorySheet.getLastRow() + 1, 1, missing.length, INVENTORY_HEADERS.length).setValues(missing);
  return missing.length;
}

function productCatalogMap_(sheet) {
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, PRODUCT_HEADERS.length).getValues();
  rows.forEach((row, i) => {
    const sku = String(row[1] || "").trim().toUpperCase();
    if (!sku) return;
    if (map[sku]) throw new Error("Duplicate SKU in Products sheet: " + sku);
    map[sku] = {
      row: i + 2,
      productId: String(row[0] || "").trim(),
      sku,
      name: String(row[2] || "").trim(),
      color: String(row[3] || "").trim(),
      size: String(row[4] || "").trim(),
      price: Number(row[5] || 0),
      active: /^(yes|true|1|active)$/i.test(String(row[6] || "").trim())
    };
  });
  return map;
}

function validateAndPriceItems_(rawItems, catalog) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error("The order has no items.");
  return rawItems.map(raw => {
    const sku = String(raw.sku || "").trim().toUpperCase();
    const qty = Number(raw.qty);
    if (!sku || !Number.isInteger(qty) || qty < 1) throw new Error("One or more order items are invalid.");
    const p = catalog[sku];
    if (!p) throw new Error("Unknown SKU: " + sku);
    if (!p.active) throw new Error("This product variation is currently unavailable: " + sku);
    if (!p.productId || !p.name || !p.color || !p.size || !(p.price >= 0)) throw new Error("Incomplete catalog entry for " + sku);
    return {
      productId: p.productId,
      sku: p.sku,
      name: p.name,
      color: p.color,
      size: p.size,
      qty,
      unitPrice: p.price,
      lineTotal: p.price * qty
    };
  });
}

function ensureInventoryRows_(sheet, items) {
  const map = inventoryMap_(sheet);
  const missing = [];
  items.forEach(item => {
    if (!map[item.sku]) {
      missing.push([item.sku, item.name, item.color, item.size, 0, 0, 0]);
      map[item.sku] = true;
    }
  });
  if (missing.length) sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, INVENTORY_HEADERS.length).setValues(missing);
}

function inventoryMap_(sheet) {
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, INVENTORY_HEADERS.length).getValues();
  rows.forEach((row, i) => {
    const sku = String(row[0] || "").trim().toUpperCase();
    if (sku) map[sku] = { row: i + 2, values: row };
  });
  return map;
}

function getOrderItems_(sheet, orderNumber) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ITEM_HEADERS.length).getValues()
    .filter(row => String(row[1]).trim() === orderNumber)
    .map(row => ({ sku: String(row[3]).trim().toUpperCase(), quantity: Number(row[7] || 0) }));
}

function combineSkuItems_(items) {
  const map = {};
  items.forEach(item => {
    const sku = String(item.sku || "").trim().toUpperCase();
    if (!map[sku]) map[sku] = { sku, quantity: 0 };
    map[sku].quantity += Number(item.quantity || 0);
  });
  return Object.values(map);
}

function orderSignature_(payload, items) {
  const normalized = items.map(i => `${i.sku}|${i.qty}`).sort().join(";");
  return [String(payload.email || "").toLowerCase().trim(), normalizePhone_(payload.mobile), normalized].join("::");
}

function findLikelyDuplicate_(sheet, payload, signature, submittedAt) {
  if (sheet.getLastRow() < 2) return "";
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length).getValues();
  const cutoff = submittedAt.getTime() - DUPLICATE_WINDOW_MINUTES * 60 * 1000;
  const email = String(payload.email || "").toLowerCase().trim();
  const mobile = normalizePhone_(payload.mobile);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const when = new Date(row[0]).getTime();
    if (when && when < cutoff) break;
    const sameContact = (email && String(row[3]).toLowerCase().trim() === email) || (mobile && normalizePhone_(row[4]) === mobile);
    if (sameContact && String(row[13]) === signature) return String(row[1]);
  }
  return "";
}

function validateCustomer_(payload) {
  if (!payload.name || !payload.email || !payload.mobile || !payload.address) throw new Error("Required customer information is missing.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email).trim())) throw new Error("Enter a valid email address.");
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error("No order data was received.");
  try { return JSON.parse(e.postData.contents); } catch (_) { throw new Error("The submitted order data is invalid."); }
}

function getSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty(SPREADSHEET_PROPERTY_KEY);
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    properties.setProperty(SPREADSHEET_PROPERTY_KEY, active.getId());
    return active;
  }
  throw new Error("No spreadsheet configured. Run setupMistBackend() once.");
}

function nextOrderNumber_() {
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy");
  const key = "ORDER_COUNTER_" + year;
  const props = PropertiesService.getScriptProperties();
  const current = Number(props.getProperty(key) || (FIRST_ORDER_NUMBER - 1));
  const next = current + 1;
  props.setProperty(key, String(next));
  return `${ORDER_PREFIX}-${year}-${String(next).padStart(4, "0")}`;
}

function resetCurrentYearCounter(lastUsedNumber) {
  const value = Number(lastUsedNumber);
  if (!Number.isInteger(value) || value < 0) throw new Error("Enter a whole number of 0 or higher.");
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy");
  PropertiesService.getScriptProperties().setProperty("ORDER_COUNTER_" + year, String(value));
  return `Next order will be ${ORDER_PREFIX}-${year}-${String(value + 1).padStart(4, "0")}`;
}

function formatAllSheets_(sheets) {
  formatProductsSheet_(sheets.products);
  formatOrdersSheet_(sheets.orders);
  formatItemsSheet_(sheets.items);
  formatInventorySheet_(sheets.inventory);
}
function formatProductsSheet_(sheet) {
  sheet.setFrozenRows(1); styleHeader_(sheet, PRODUCT_HEADERS.length);
  sheet.getRange("F:F").setNumberFormat('₱#,##0.00');
  sheet.setColumnWidths(1, PRODUCT_HEADERS.length, 140); sheet.setColumnWidth(3, 220);
  setListValidation_(sheet, 7, ["Yes", "No"]); ensureFilter_(sheet, PRODUCT_HEADERS.length);
}
function formatOrdersSheet_(sheet) {
  sheet.setFrozenRows(1); styleHeader_(sheet, ORDER_HEADERS.length);
  sheet.getRange("A:A").setNumberFormat("mmm d, yyyy h:mm AM/PM");
  sheet.getRange("H:H").setNumberFormat('₱#,##0.00');
  sheet.setColumnWidths(1, ORDER_HEADERS.length, 140); sheet.setColumnWidth(3, 180); sheet.setColumnWidth(4, 220); sheet.setColumnWidth(6, 300); sheet.setColumnWidth(13, 250);
  setListValidation_(sheet, 9, ORDER_STATUSES); setListValidation_(sheet, 10, PAYMENT_STATUSES); ensureFilter_(sheet, ORDER_HEADERS.length);
  try { sheet.hideColumns(14); } catch (_) {}
}
function formatItemsSheet_(sheet) {
  sheet.setFrozenRows(1); styleHeader_(sheet, ITEM_HEADERS.length);
  sheet.getRange("A:A").setNumberFormat("mmm d, yyyy h:mm AM/PM"); sheet.getRange("I:J").setNumberFormat('₱#,##0.00');
  sheet.setColumnWidths(1, ITEM_HEADERS.length, 140); sheet.setColumnWidth(5, 220); ensureFilter_(sheet, ITEM_HEADERS.length);
}
function formatInventorySheet_(sheet) {
  sheet.setFrozenRows(1); styleHeader_(sheet, INVENTORY_HEADERS.length);
  sheet.setColumnWidths(1, INVENTORY_HEADERS.length, 140); sheet.setColumnWidth(2, 220); sheet.getRange("E:G").setNumberFormat("0"); ensureFilter_(sheet, INVENTORY_HEADERS.length);
}
function styleHeader_(sheet, count) { sheet.getRange(1, 1, 1, count).setFontWeight("bold").setBackground("#111111").setFontColor("#ffffff"); }
function setListValidation_(sheet, column, values) {
  const validation = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(validation);
}
function ensureFilter_(sheet, columns) { if (!sheet.getFilter()) sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), columns).createFilter(); }
function formatNewOrderRow_(sheet, row) { sheet.getRange(row, 1).setNumberFormat("mmm d, yyyy h:mm AM/PM"); sheet.getRange(row, 8).setNumberFormat('₱#,##0.00'); }
function formatNewItemRows_(sheet, startRow, count) { if (count) { sheet.getRange(startRow, 1, count, 1).setNumberFormat("mmm d, yyyy h:mm AM/PM"); sheet.getRange(startRow, 9, count, 2).setNumberFormat('₱#,##0.00'); } }
function headersMatch_(sheet, expected) {
  if (sheet.getLastColumn() < expected.length) return false;
  const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  return expected.every((header, i) => String(actual[i]).trim() === header);
}
function uniqueSheetName_(spreadsheet, base) { let name = base, n = 2; while (spreadsheet.getSheetByName(name)) name = base + " " + n++; return name; }
function normalizePhone_(value) { return String(value || "").replace(/\D/g, ""); }
function jsonResponse_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function checkSpreadsheetConnection() {
  const ss = getSpreadsheet_();
  return { name: ss.getName(), id: ss.getId(), url: ss.getUrl(), sheets: ss.getSheets().map(s => s.getName()) };
}


/** Run from Apps Script to verify the backend without using the website. */
function testBackendOrder() {
  const event = {
    postData: {
      contents: JSON.stringify({
        name: "MIST Test Customer",
        email: "test@example.com",
        mobile: "09171234567",
        address: "Test address",
        notes: "Backend connection test",
        items: [{ sku: "AFS-WHT-XS", qty: 1 }]
      })
    }
  };

  const response = doPost(event);
  const text = response.getContent();
  console.log(text);
  return text;
}
