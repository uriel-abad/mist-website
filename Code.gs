/**
 * MIST order endpoint for a Google Sheet-bound Apps Script project.
 * Replace your existing Code.gs with this file, then deploy a new web-app version.
 */

const ORDER_PREFIX = "MIST";
const FIRST_ORDER_NUMBER = 1;
const SHEET_NAME = "Orders";

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    validateOrder_(payload);

    const orderNumber = nextOrderNumber_();
    const sheet = getOrdersSheet_();
    ensureHeaders_(sheet);

    const itemSummary = (payload.items || []).map(function(item) {
      return [item.name, item.color, "Size " + item.size, "Qty " + item.qty].join(" | ");
    }).join(" ; ");

    sheet.appendRow([
      new Date(),
      orderNumber,
      payload.name || "",
      payload.mobile || "",
      payload.contact || "",
      payload.address || "",
      itemSummary,
      Number(payload.subtotal || 0),
      payload.notes || "",
      "New"
    ]);

    return json_({ ok: true, orderNumber: orderNumber });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
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

function getOrdersSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("This Apps Script must be bound to your Google Sheet.");
  return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow([
    "Submitted At", "Order Number", "Customer Name", "Mobile", "Contact",
    "Delivery Address", "Items", "Subtotal", "Notes", "Status"
  ]);
  sheet.setFrozenRows(1);
}

function validateOrder_(payload) {
  if (!payload.name || !payload.mobile || !payload.address) {
    throw new Error("Required customer information is missing.");
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("The order has no items.");
  }
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Manual reset: change 0 to the last number already used.
 * Example: resetCurrentYearCounter(0) makes the next order end in 0001.
 * Avoid resetting to 0 after real orders exist, because that creates duplicates.
 */
function resetCurrentYearCounter(lastUsedNumber) {
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy");
  const value = Number(lastUsedNumber);
  if (!Number.isInteger(value) || value < 0) throw new Error("Enter a whole number of 0 or higher.");
  PropertiesService.getScriptProperties().setProperty("ORDER_COUNTER_" + year, String(value));
  return "Next order will be " + ORDER_PREFIX + "-" + year + "-" + String(value + 1).padStart(4, "0");
}
