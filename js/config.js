"use strict";

window.MIST = window.MIST || {};

MIST.config = {
  productsUrl: "data/products.json",
  // Your Facebook page username, e.g. "mist.activewear" → m.me/mist.activewear
  messengerUsername: "uriel.abad",
  // Your Instagram username without @.
  instagramUsername: "urielovesamgyup",
  // Reliable profile URL used by the order button. Instagram no longer reliably supports username-based direct-message deep links.
  instagramUrl: "https://www.instagram.com/urielovesamgyup/",
  // Optional — leave as-is (or blank) if you don't want a spreadsheet backup log.
  // Orders still send fine through Messenger/Instagram without it.
  gasEndpoint:
    "https://script.google.com/macros/s/AKfycbxGjikHAt7CebhPhFeDnpnnbLdY2yeQiURx7q2u1ztANK3KZ_4X3PD8T5m4gyUHzHo/exec",
};
