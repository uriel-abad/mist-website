"use strict";

window.MIST = window.MIST || {};

MIST.ui = (() => {
  const elements = {
    productGrid: document.getElementById("product-grid"),
    orderPanel: document.getElementById("order-panel"),
    navCount: document.getElementById("nav-count"),
    submitButton: document.getElementById("submit-order"),
    summaryLines: document.getElementById("summary-lines"),
    orderForm: document.getElementById("order-form"),
    toast: document.getElementById("toast"),
    menuToggle: document.getElementById("menuToggle"),
    navLinks: document.querySelector(".nav-links"),
    helpMessengerLink: document.getElementById("help-messenger-link"),
    orderNumberResult: document.getElementById("order-number-result"),
  };

  let toastTimer;

  function formatMoney(value) {
    return `₱${Number(value).toLocaleString("en-PH")}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 1800);
  }

  function renderLoading() {
    elements.productGrid.innerHTML = '<p class="catalogue-message">Loading products…</p>';
  }

  function renderLoadError() {
    elements.productGrid.innerHTML = `
      <div class="catalogue-message catalogue-error">
        <strong>Products could not be loaded.</strong><br>
        Open this project through a web server rather than double-clicking index.html.
        See README.md for instructions.
      </div>`;
  }

  function productCard(product, selection) {
    const color = selection.color;
    const images = product.colors[color];
    const colorButtons = Object.keys(product.colors)
      .map((name) => `
        <button type="button" class="color-btn ${name === color ? "active" : ""}"
          data-action="select-color" data-product-id="${escapeHtml(product.id)}"
          data-color="${escapeHtml(name)}" aria-pressed="${name === color}">${escapeHtml(name)}</button>`)
      .join("");

    const sizeButtons = product.sizes
      .map((size) => `
        <button type="button" class="size-btn ${size === selection.size ? "active" : ""}"
          data-action="select-size" data-product-id="${escapeHtml(product.id)}"
          data-size="${escapeHtml(size)}" aria-pressed="${size === selection.size}">${escapeHtml(size)}</button>`)
      .join("");

    return `
      <article class="card" data-product-id="${escapeHtml(product.id)}">
        <div class="card-img">
          ${product.badge ? `<span class="badge">${escapeHtml(product.badge)}</span>` : ""}
          <img class="img-front" src="${escapeHtml(images.front)}" alt="${escapeHtml(product.name)} in ${escapeHtml(color)}, front view">
          <img class="img-back" src="${escapeHtml(images.back)}" alt="${escapeHtml(product.name)} in ${escapeHtml(color)}, back view">
          <button type="button" class="quick-add" data-action="add-to-order" data-product-id="${escapeHtml(product.id)}">Add to Order</button>
        </div>
        <div class="card-body">
          <div class="card-body-top">
            <h3>${escapeHtml(product.name)}</h3>
            <div class="price">${formatMoney(product.price)}</div>
          </div>
          <div class="colors" aria-label="Choose a color">${colorButtons}</div>
          <div class="sizes" aria-label="Choose a size">${sizeButtons}</div>
        </div>
      </article>`;
  }

  function renderProducts(products, selections) {
    elements.productGrid.innerHTML = products
      .map((product) => productCard(product, selections[product.id]))
      .join("");
  }

  function updateProductSelection(product, selection) {
    const card = elements.productGrid.querySelector(`[data-product-id="${CSS.escape(product.id)}"]`);
    if (!card) return;

    const images = product.colors[selection.color];
    const front = card.querySelector(".img-front");
    const back = card.querySelector(".img-back");
    front.src = images.front;
    front.alt = `${product.name} in ${selection.color}, front view`;
    back.src = images.back;
    back.alt = `${product.name} in ${selection.color}, back view`;

    card.querySelectorAll('[data-action="select-color"]').forEach((button) => {
      const active = button.dataset.color === selection.color;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    card.querySelectorAll('[data-action="select-size"]').forEach((button) => {
      const active = button.dataset.size === selection.size;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  return {
    elements,
    formatMoney,
    escapeHtml,
    showToast,
    renderLoading,
    renderLoadError,
    renderProducts,
    updateProductSelection,
  };
})();
