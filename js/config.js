"use strict";

window.MIST = window.MIST || {};

MIST.config = {
  productsUrl: "data/products.json",
  // Your Facebook page username, e.g. "marichris.milanes" → m.me/marichris.milanes
  messengerUsername: "marichris.milanes",
  // Optional — leave as-is (or blank) if you don't want a spreadsheet backup log.
  // Orders still send fine through Messenger without it.
  gasEndpoint:
    "https://script.google.com/macros/s/AKfycbxGjikHAt7CebhPhFeDnpnnbLdY2yeQiURx7q2u1ztANK3KZ_4X3PD8T5m4gyUHzHo/exec",
};
