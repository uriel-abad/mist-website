"use strict";

window.MIST = window.MIST || {};

MIST.config = {
  productsUrl: "data/products.json",
  // Your Facebook page username, e.g. "marichris.milanes" → m.me/marichris.milanes
  messengerUsername: "marichris.milanes",
  // Optional — leave as-is (or blank) if you don't want a spreadsheet backup log.
  // Orders still send fine through Messenger without it.
  gasEndpoint:
    "https://script.google.com/macros/s/AKfycbwksqVszNRbYfun2CT_P48mmgkPyIgkr7XeNLxeifPcB8H9BkSviVL5j2POIiXUzW8/exec",
};
