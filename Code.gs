/**
 * MIST order endpoint and order-management workflow.
 *
 * Sheets created:
 *   Orders      — one row per customer order
 *   Order Items — one row per product/color/size
 *   Inventory   — stock, reserved stock, and available stock per variation
 *
 * Inventory rules:
 *   New / Suspicious / Duplicate / Cancelled: no inventory held
 *   Confirmed / Packed: inventory is reserved
 *   Shipped / Delivered: reserved inventory becomes sold stock
 *
 * Run setupOrderSheets() once, then deploy a new Web App version.
 */

const SPREADSHEET_ID = "15eNplQ-kg3ycIMUjFSISqXSDf566TJ1qDLuFyKS8i9Y";

const ORDER_PREFIX = "MIST";
const FIRST_ORDER_NUMBER = 1;
const ORDERS_SHEET_NAME = "Orders";
const ITEMS_SHEET_NAME = "Order Items";
const INVENTORY_SHEET_NAME = "Inventory";
const DUPLICATE_WINDOW_MINUTES = 30;

const ORDER_STATUSES = [
  "New", "Confirmed", "Packed", "Shipped", "Delivered",
  "Cancelled", "Duplicate", "Suspicious"
];
const PAYMENT_STATUSES = ["Pending", "Paid", "Refunded", "COD"];

const ORDER_HEADERS = [
  "Submitted At", "Order Number", "Customer Name", "Email", "Mobile",
  "Delivery Address", "Total Quantity", "Subtotal", "Status",
  "Payment Status", "Duplicate Check", "Inventory State", "Notes",
  "Order Signature"
];

const ITEM_HEADERS = [
  "Submitted At", "Order Number", "Product", "Color", "Size",
  "Quantity", "Unit Price", "Line Total"
];

const INVENTORY_HEADERS = [
  "Product", "Color", "Size", "Stock", "Reserved", "Available"
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    validateOrder_(payload);

    const spreadsheet = getSpreadsheet_();
    const sheets = prepareSheets_(spreadsheet);
    const submittedAt = new Date();
    const orderNumber = nextOrderNumber_();
    const items = normalizeItems_(payload.items);
    const totalQuantity = items.reduce((sum, item) => sum + item.qty, 0);
    const subtotal = Number(payload.subtotal || items.reduce((sum, item) => sum + item.lineTotal, 0));
    const signature = orderSignature_(payload, items);
    const duplicate = findLikelyDuplicate_(sheets.orders, payload, signature, submittedAt);
    const initialStatus = duplicate ? "Suspicious" : "New";
    const duplicateText = duplicate ? "Possible duplicate of " + duplicate : "Clear";

    sheets.orders.appendRow([
      submittedAt,
      orderNumber,
      payload.name || "",
      payload.email || "",
      payload.mobile || "",
      payload.address || "",
      totalQuantity,
      subtotal,
      initialStatus,
      "Pending",
      duplicateText,
      "NONE",
      payload.notes || "",
      signature
    ]);

    const itemRows = items.map(item => [
      submittedAt, orderNumber, item.name, item.color, item.size,
      item.qty, item.unitPrice, item.lineTotal
    ]);

    if (itemRows.length) {
      sheets.items.getRange(sheets.items.getLastRow() + 1, 1, itemRows.length, ITEM_HEADERS.length)
        .setValues(itemRows);
    }

    ensureInventoryVariations_(sheets.inventory, items);
    formatNewOrderRow_(sheets.orders, sheets.orders.getLastRow());
    formatNewItemRows_(sheets.items, sheets.items.getLastRow() - itemRows.length + 1, itemRows.length);

    return json_({
      ok: true,
      orderNumber,
      totalQuantity,
      possibleDuplicate: Boolean(duplicate)
    });
  } catch (error) {
    return json_({ ok: false, error: String((error && error.message) || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * Main setup function.
 * Run this once from the Apps Script editor.
 */
function setupMistBackend() {
  return setupOrderSheets();
}

/** Run once from the Apps Script editor. */
function setupOrderSheets() {
  const spreadsheet = getSpreadsheet_();
  const sheets = prepareSheets_(spreadsheet);

  formatOrdersSheet_(sheets.orders);
  formatItemsSheet_(sheets.items);
  formatInventorySheet_(sheets.inventory);

  SpreadsheetApp.flush();

  const message =
    "MIST sheets are ready: Orders, Order Items, and Inventory.";
  console.log(message);
  return message;
}

/**
 * Automatically manages reservations when Status is edited in the Orders sheet.
 * This is a simple trigger and runs whenever a user edits the spreadsheet.
 */
function onEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== ORDERS_SHEET_NAME) return;
  if (e.range.getRow() < 2 || e.range.getColumn() !== 9) return;

  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(30000);
    const sheet = e.range.getSheet();
    const newStatus = String(e.value || "").trim();
    const oldStatus = String(e.oldValue || "New").trim();
    if (!ORDER_STATUSES.includes(newStatus)) return;

    const row = e.range.getRow();
    const orderNumber = String(sheet.getRange(row, 2).getValue()).trim();
    const currentState = String(sheet.getRange(row, 12).getValue() || "NONE").trim();
    const targetState = inventoryStateForStatus_(newStatus);

    // Sold inventory is not automatically restored because a shipped order may
    // require a separate return/refund decision. Revert unsafe status changes.
    if (currentState === "SOLD" && targetState !== "SOLD") {
      e.range.setValue(oldStatus);
      e.source.toast("Inventory was already deducted. Handle returns manually before changing this status.", "MIST", 8);
      return;
    }

    if (currentState === targetState) return;

    const spreadsheet = e.source;
    const itemsSheet = spreadsheet.getSheetByName(ITEMS_SHEET_NAME);
    const inventorySheet = spreadsheet.getSheetByName(INVENTORY_SHEET_NAME);
    const items = getOrderItems_(itemsSheet, orderNumber);

    transitionInventory_(inventorySheet, items, currentState, targetState);
    sheet.getRange(row, 12).setValue(targetState);
    e.source.toast("Order " + orderNumber + " updated: " + targetState, "MIST", 5);
  } catch (error) {
    try {
      e.range.setValue(e.oldValue || "New");
      e.source.toast(String(error.message || error), "MIST inventory update failed", 10);
    } catch (_) {}
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function transitionInventory_(sheet, items, fromState, toState) {
  if (!items.length) throw new Error("No order items were found.");

  if (fromState === "NONE" && toState === "RESERVED") {
    adjustInventory_(sheet, items, 0, 1);
  } else if (fromState === "RESERVED" && toState === "NONE") {
    adjustInventory_(sheet, items, 0, -1);
  } else if (fromState === "RESERVED" && toState === "SOLD") {
    adjustInventory_(sheet, items, -1, -1);
  } else if (fromState === "NONE" && toState === "SOLD") {
    adjustInventory_(sheet, items, -1, 0);
  } else {
    throw new Error("Unsupported inventory transition: " + fromState + " to " + toState);
  }
}

function adjustInventory_(
  sheet,
  items,
  stockMultiplier,
  reservedMultiplier
) {
  const rows = inventoryMap_(sheet);
  const changes = [];

  items.forEach(item => {
    const sku = String(item.sku || "")
      .trim()
      .toUpperCase();

    const record = rows[sku];

    if (!record) {
      throw new Error(
        "SKU is missing from Inventory: " + sku
      );
    }

    const stock = Number(record.values[4] || 0);
    const reserved = Number(record.values[5] || 0);

    const newStock =
      stock +
      stockMultiplier * item.quantity;

    const newReserved =
      reserved +
      reservedMultiplier * item.quantity;

    const newAvailable =
      newStock - newReserved;

    if (newStock < 0) {
      throw new Error(
        "Not enough stock for " + sku + "."
      );
    }

    if (newReserved < 0) {
      throw new Error(
        "Reserved quantity cannot be negative for " +
          sku +
          "."
      );
    }

    if (newAvailable < 0) {
      throw new Error(
        "Not enough available stock for " +
          sku +
          "."
      );
    }

    changes.push({
      row: record.row,
      stock: newStock,
      reserved: newReserved,
      available: newAvailable
    });
  });

  changes.forEach(change => {
    sheet
      .getRange(change.row, 5, 1, 3)
      .setValues([[
        change.stock,
        change.reserved,
        change.available
      ]]);
  });
}

function inventoryStateForStatus_(status) {
  if (status === "Confirmed" || status === "Packed") return "RESERVED";
  if (status === "Shipped" || status === "Delivered") return "SOLD";
  return "NONE";
}

function prepareSheets_(spreadsheet) {
  const orders = prepareSheet_(spreadsheet, ORDERS_SHEET_NAME, ORDER_HEADERS, "Orders Legacy");
  const items = prepareSheet_(spreadsheet, ITEMS_SHEET_NAME, ITEM_HEADERS, "Order Items Legacy");
  const inventory = prepareSheet_(spreadsheet, INVENTORY_SHEET_NAME, INVENTORY_HEADERS, "Inventory Legacy");
  formatOrdersSheet_(orders);
  formatItemsSheet_(items);
  formatInventorySheet_(inventory);
  return { orders, items, inventory };
}

function prepareSheet_(spreadsheet, name, headers, legacyBase) {
  let sheet = spreadsheet.getSheetByName(name);
  if (sheet && sheet.getLastRow() > 0 && !headersMatch_(sheet, headers)) {
    sheet.setName(uniqueSheetName_(spreadsheet, legacyBase));
    sheet = null;
  }
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  ensureHeaders_(sheet, headers);
  return sheet;
}

function normalizeItems_(items) {
  return items.map(item => {
    const qty = Math.max(1, Number(item.qty || 1));
    const lineTotal = Number(item.lineTotal || 0);
    const unitPrice = Number(item.unitPrice || (lineTotal / qty) || 0);
    return {
      name: String(item.name || "").trim(),
      color: String(item.color || "").trim(),
      size: String(item.size || "").trim(),
      qty,
      unitPrice,
      lineTotal: lineTotal || unitPrice * qty
    };
  });
}

function orderSignature_(payload, items) {
  const normalizedItems = items
    .map(item => [item.name, item.color, item.size, item.qty].join("|").toLowerCase())
    .sort()
    .join(";");
  return [String(payload.email || "").toLowerCase().trim(), normalizePhone_(payload.mobile), normalizedItems].join("::");
}

function findLikelyDuplicate_(sheet, payload, signature, submittedAt) {
  if (sheet.getLastRow() < 2) return "";
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length).getValues();
  const cutoff = submittedAt.getTime() - DUPLICATE_WINDOW_MINUTES * 60 * 1000;
  const email = String(payload.email || "").toLowerCase().trim();
  const mobile = normalizePhone_(payload.mobile);

  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    const when = new Date(row[0]).getTime();
    if (!when || when < cutoff) break;
    const sameContact = (email && String(row[3]).toLowerCase().trim() === email) ||
      (mobile && normalizePhone_(row[4]) === mobile);
    if (sameContact && String(row[13]) === signature) return String(row[1]);
  }
  return "";
}

function getOrderItems_(sheet, orderNumber) {
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  return sheet
    .getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      sheet.getLastColumn()
    )
    .getValues()
    .filter(row =>
      String(row[1] || "").trim() === orderNumber
    )
    .map(row => ({
      sku: String(row[3] || "").trim().toUpperCase(),
      product: String(row[4] || "").trim(),
      color: String(row[5] || "").trim(),
      size: String(row[6] || "").trim(),
      quantity: Number(row[7] || 0)
    }));
}

function ensureInventoryVariations_(sheet, items) {
  const map = inventoryMap_(sheet);
  const missing = [];
  items.forEach(item => {
    const key = inventoryKey_(item.name, item.color, item.size);
    if (!map[key]) {
      missing.push([item.name, item.color, item.size, 0, 0, 0]);
      map[key] = true;
    }
  });
  if (missing.length) sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 6).setValues(missing);
}

function inventoryMap_(sheet) {
  const map = {};

  if (!sheet || sheet.getLastRow() < 2) {
    return map;
  }

  const values = sheet
    .getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      7
    )
    .getValues();

  values.forEach((row, index) => {
    const sku = String(row[0] || "")
      .trim()
      .toUpperCase();

    if (sku) {
      map[sku] = {
        row: index + 2,
        values: row
      };
    }
  });

  return map;
}

function inventoryKey_(product, color, size) {
  return [
    product,
    color,
    size
  ]
    .map(value => String(value || "").trim())
    .join(" | ");
}

function nextOrderNumber_() {
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy");
  const key = "ORDER_COUNTER_" + year;
  const properties = PropertiesService.getScriptProperties();
  const current = Number(properties.getProperty(key) || (FIRST_ORDER_NUMBER - 1));
  const next = current + 1;
  properties.setProperty(key, String(next));
  return ORDER_PREFIX + "-" + year + "-" + String(next).padStart(4, "0");
}

function formatOrdersSheet_(sheet) {
  sheet.setFrozenRows(1);
  styleHeader_(sheet, ORDER_HEADERS.length);
  sheet.getRange("A:A").setNumberFormat("mmm d, yyyy h:mm AM/PM");
  sheet.getRange("H:H").setNumberFormat('₱#,##0.00');
  sheet.setColumnWidths(1, ORDER_HEADERS.length, 140);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(6, 300);
  sheet.setColumnWidth(11, 190);
  sheet.setColumnWidth(13, 250);
  sheet.hideColumns(14);

  setListValidation_(sheet, 9, ORDER_STATUSES);
  setListValidation_(sheet, 10, PAYMENT_STATUSES);
  ensureFilter_(sheet, ORDER_HEADERS.length);
}

function formatItemsSheet_(sheet) {
  sheet.setFrozenRows(1);
  styleHeader_(sheet, ITEM_HEADERS.length);
  sheet.getRange("A:A").setNumberFormat("mmm d, yyyy h:mm AM/PM");
  sheet.getRange("G:H").setNumberFormat('₱#,##0.00');
  sheet.setColumnWidths(1, ITEM_HEADERS.length, 140);
  sheet.setColumnWidth(3, 220);
  ensureFilter_(sheet, ITEM_HEADERS.length);
}

function formatInventorySheet_(sheet) {
  sheet.setFrozenRows(1);
  styleHeader_(sheet, INVENTORY_HEADERS.length);
  sheet.setColumnWidths(1, INVENTORY_HEADERS.length, 140);
  sheet.setColumnWidth(1, 220);
  sheet.getRange("D:F").setNumberFormat("0");
  ensureFilter_(sheet, INVENTORY_HEADERS.length);
}

function styleHeader_(sheet, count) {
  sheet.getRange(1, 1, 1, count).setFontWeight("bold").setBackground("#111111").setFontColor("#ffffff");
}

function setListValidation_(sheet, column, values) {
  const validation = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(validation);
}

function ensureFilter_(sheet, columns) {
  if (!sheet.getFilter()) sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), columns).createFilter();
}

function formatNewOrderRow_(sheet, row) {
  sheet.getRange(row, 1).setNumberFormat("mmm d, yyyy h:mm AM/PM");
  sheet.getRange(row, 8).setNumberFormat('₱#,##0.00');
}

function formatNewItemRows_(sheet, startRow, rowCount) {
  if (rowCount < 1) return;
  sheet.getRange(startRow, 1, rowCount, 1).setNumberFormat("mmm d, yyyy h:mm AM/PM");
  sheet.getRange(startRow, 7, rowCount, 2).setNumberFormat('₱#,##0.00');
}

function validateOrder_(payload) {
  if (!payload.name || !payload.email || !payload.mobile || !payload.address) {
    throw new Error("Required customer information is missing.");
  }
  if (!/^\S+@\S+\.\S+$/.test(String(payload.email))) throw new Error("Enter a valid email address.");
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error("The order has no items.");
  payload.items.forEach(item => {
    if (!item.name || !item.color || !item.size || Number(item.qty) < 1) {
      throw new Error("One or more order items are incomplete.");
    }
  });
}

function normalizePhone_(value) { return String(value || "").replace(/\D/g, ""); }
function getSpreadsheet_() {
  if (!SPREADSHEET_ID) {
    throw new Error("Spreadsheet ID is missing.");
  }

  return SpreadsheetApp.openById(SPREADSHEET_ID);
}
function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}
function headersMatch_(sheet, expected) {
  if (sheet.getLastColumn() < expected.length) return false;
  const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  return expected.every((header, index) => String(actual[index]).trim() === header);
}
function uniqueSheetName_(spreadsheet, baseName) {
  let name = baseName, number = 2;
  while (spreadsheet.getSheetByName(name)) name = baseName + " " + number++;
  return name;
}
function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/** resetCurrentYearCounter(0) makes the next order end in 0001. */
function resetCurrentYearCounter(lastUsedNumber) {
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy");
  const value = Number(lastUsedNumber);
  if (!Number.isInteger(value) || value < 0) throw new Error("Enter a whole number of 0 or higher.");
  PropertiesService.getScriptProperties().setProperty("ORDER_COUNTER_" + year, String(value));
  return "Next order will be " + ORDER_PREFIX + "-" + year + "-" + String(value + 1).padStart(4, "0");
}
