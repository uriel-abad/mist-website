"use strict";

window.MIST = window.MIST || {};

MIST.app = (() => {
  const state = {
    products: [],
    productsById: new Map(),
    selections: {},
  };

  async function loadProducts() {
    const response = await fetch(MIST.config.productsUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load products: ${response.status}`);
    const products = await response.json();
    if (!Array.isArray(products) || products.length === 0) throw new Error("No products found");
    return products;
  }

  function prepareProducts(products) {
    state.products = products;
    state.productsById = new Map(products.map((product) => [product.id, product]));
    products.forEach((product) => {
      const colors = Object.keys(product.colors || {});
      if (!product.id || !product.name || !colors.length || !product.sizes?.length) {
        throw new Error(`Invalid product entry: ${product.id || "unknown"}`);
      }
      state.selections[product.id] = {
        color: product.defaultColor && product.colors[product.defaultColor]
          ? product.defaultColor
          : colors[0],
        size: null,
      };
    });
  }

  function product(productId) {
    return state.productsById.get(productId);
  }

  function handleProductClick(event) {
    const button = event.target.closest("[data-action][data-product-id]");
    if (!button) return;

    const productId = button.dataset.productId;
    const selectedProduct = product(productId);
    const selection = state.selections[productId];
    if (!selectedProduct || !selection) return;

    if (button.dataset.action === "select-color") selection.color = button.dataset.color;
    if (button.dataset.action === "select-size") selection.size = button.dataset.size;

    if (button.dataset.action === "add-to-order") {
      if (!selection.size) {
        MIST.ui.showToast("Select a size first");
        return;
      }
      const result = MIST.cart.add(productId, selection.color, selection.size);
      MIST.ui.showToast(result.merged
        ? "Quantity updated in your Shopping Bag"
        : "Added to your Shopping Bag");
      return;
    }

    MIST.ui.updateProductSelection(selectedProduct, selection);
  }

  function buildOrderPayload() {
    return {
      name: document.getElementById("f-name").value.trim(),
      mobile: document.getElementById("f-mobile").value.trim(),
      contact: document.getElementById("f-contact").value.trim(),
      address: document.getElementById("f-address").value.trim(),
      notes: document.getElementById("f-notes").value.trim(),
      items: MIST.cart.payloadItems(),
      subtotal: MIST.cart.subtotal(),
      submittedAt: new Date().toISOString(),
    };
  }

  function buildOrderMessage(payload) {
    const lines = payload.items
      .map((item) => `• ${item.name} — ${item.color}, size ${item.size} × ${item.qty} (${MIST.ui.formatMoney(item.lineTotal)})`)
      .join("\n");

    return `New order request — MIST

Name: ${payload.name}
Mobile: ${payload.mobile}
Contact: ${payload.contact}
Address: ${payload.address}

Items:
${lines}

Estimated subtotal: ${MIST.ui.formatMoney(payload.subtotal)}
Notes: ${payload.notes || "—"}

No payment yet — please confirm stock and shipping first.`;
  }

  function logToSheetSilently(payload) {
    const endpoint = MIST.config.gasEndpoint;
    if (!endpoint || endpoint.includes("PASTE_YOUR")) return;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).catch(() => { /* silent — Messenger/Instagram send already succeeded */ });
  }

  async function sendOrder(channel, button) {
    const { elements, showToast } = MIST.ui;
    if (!elements.orderForm.reportValidity() || MIST.cart.isEmpty()) return;

    const rawUsername = channel === "messenger"
      ? MIST.config.messengerUsername
      : MIST.config.instagramUsername;
    const username = String(rawUsername || "").trim().replace(/^@/, "");

    if (!username || username.includes("PASTE_YOUR")) {
      showToast(`Add your ${channel === "messenger" ? "Messenger" : "Instagram"} username in js/config.js first`);
      return;
    }

    const url = channel === "messenger"
      ? `https://m.me/${encodeURIComponent(username)}`
      : (MIST.config.instagramUrl || `https://www.instagram.com/${encodeURIComponent(username)}/`);

    // Open immediately during the click event so mobile browsers do not block it
    // after the asynchronous clipboard operation.
    const chatWindow = window.open("about:blank", "_blank");

    const payload = buildOrderPayload();
    const message = buildOrderMessage(payload);
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Opening…";

    try {
      await navigator.clipboard.writeText(message);
      showToast("Order copied — paste it into the chat that opens");
    } catch (error) {
      showToast("Could not auto-copy — you may need to copy the order manually");
    }

    if (chatWindow && !chatWindow.closed) {
      chatWindow.location.replace(url);
    } else {
      // Fallback for strict popup blockers.
      window.location.href = url;
    }

    logToSheetSilently(payload);
    MIST.cart.clear();
    elements.orderForm.reset();
    button.textContent = originalLabel;
    button.disabled = true;
  }

  function applyHelpLinks() {
    const { elements } = MIST.ui;
    const { messengerUsername, instagramUsername } = MIST.config;
    if (messengerUsername && !messengerUsername.includes("PASTE_YOUR") && elements.helpMessengerLink) {
      elements.helpMessengerLink.href = `https://m.me/${messengerUsername}`;
      elements.helpMessengerLink.target = "_blank";
      elements.helpMessengerLink.rel = "noopener noreferrer";
    }
    if (instagramUsername && !instagramUsername.includes("PASTE_YOUR") && elements.helpInstagramLink) {
      elements.helpInstagramLink.href = `https://www.instagram.com/${instagramUsername}/`;
      elements.helpInstagramLink.target = "_blank";
      elements.helpInstagramLink.rel = "noopener noreferrer";
    }
  }

  function syncStickyNavOffset() {
    const nav = document.querySelector("header.site-nav");
    if (!nav) return;

    const updateOffset = () => {
      const height = Math.ceil(nav.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--site-nav-height", `${height}px`);
    };

    updateOffset();
    window.addEventListener("resize", updateOffset, { passive: true });

    if ("ResizeObserver" in window) {
      new ResizeObserver(updateOffset).observe(nav);
    }
  }

  function scrollToSection(target, behavior = "smooth") {
    const nav = document.querySelector("header.site-nav");
    const navHeight = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
    const anchorGap = 16;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - anchorGap;

    window.scrollTo({
      top: Math.max(0, top),
      behavior,
    });
  }

  function bindAnchorNavigation() {
    document.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;

      const targetId = link.getAttribute("href");
      if (!targetId || targetId === "#") return;

      const target = document.querySelector(targetId);
      if (!target) return;

      event.preventDefault();
      MIST.ui.elements.navLinks.classList.remove("mobile-open");
      history.pushState(null, "", targetId);

      requestAnimationFrame(() => scrollToSection(target));
    });

    window.addEventListener("popstate", () => {
      if (!window.location.hash) return;
      const target = document.querySelector(window.location.hash);
      if (target) requestAnimationFrame(() => scrollToSection(target));
    });

    window.addEventListener("load", () => {
      if (!window.location.hash) return;
      const target = document.querySelector(window.location.hash);
      if (target) requestAnimationFrame(() => scrollToSection(target, "auto"));
    });
  }

  function bindEvents() {
    const { elements } = MIST.ui;
    elements.productGrid.addEventListener("click", handleProductClick);
    elements.orderPanel.addEventListener("change", (event) => {
      const control = event.target.closest('[data-action^="cart-"]');
      if (control) {
        const result = MIST.cart.update(control);
        if (result.merged) MIST.ui.showToast("Matching items were combined");
      }
    });
    elements.orderPanel.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="cart-remove"]');
      if (button) MIST.cart.remove(Number(button.dataset.row));
    });
    elements.submitButton.addEventListener("click", () => sendOrder("messenger", elements.submitButton));
    elements.submitButtonIg.addEventListener("click", () => sendOrder("instagram", elements.submitButtonIg));
    elements.menuToggle.addEventListener("click", () => elements.navLinks.classList.toggle("mobile-open"));
  }

  async function initialize() {
    MIST.ui.renderLoading();
    syncStickyNavOffset();
    bindAnchorNavigation();
    bindEvents();
    applyHelpLinks();
    try {
      const products = await loadProducts();
      prepareProducts(products);
      MIST.ui.renderProducts(state.products, state.selections);
      MIST.cart.initialize(state.products);
    } catch (error) {
      console.error(error);
      MIST.ui.renderLoadError();
    }
  }

  return { initialize };
})();

document.addEventListener("DOMContentLoaded", MIST.app.initialize);
