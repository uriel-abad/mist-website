"use strict";

window.MIST = window.MIST || {};

MIST.cart = (() => {
  let items = [];
  let nextRowId = 1;
  let productsById = new Map();

  function initialize(products) {
    productsById = new Map(products.map((product) => [product.id, product]));
    render();
  }

  function getProduct(productId) {
    return productsById.get(productId);
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function skuFor(product, color, size) {
    const colorData = product && product.colors ? product.colors[color] : null;
    const productCode = String(product && product.productCode || "").trim().toUpperCase();
    const colorCode = String(colorData && colorData.code || "").trim().toUpperCase();
    const sizeCode = String(size || "").trim().toUpperCase();
    if (!productCode || !colorCode || !sizeCode) return "";
    return `${productCode}-${colorCode}-${sizeCode}`;
  }

  function variantKey(item) {
    return [item.productId, normalize(item.color), normalize(item.size)].join("::");
  }

  function mergeDuplicateVariants() {
    const merged = new Map();
    let duplicatesMerged = false;

    items.forEach((item) => {
      const key = variantKey(item);
      const existing = merged.get(key);

      if (existing) {
        existing.qty += item.qty;
        duplicatesMerged = true;
      } else {
        merged.set(key, { ...item });
      }
    });

    items = Array.from(merged.values());
    return duplicatesMerged;
  }

  function add(productId, color, size) {
    const product = getProduct(productId);
    if (!product) return { added: false, merged: false };

    const newItem = {
      rowId: nextRowId++,
      productId,
      color,
      size,
      qty: 1,
    };

    const key = variantKey(newItem);
    const existing = items.find((item) => variantKey(item) === key);

    if (existing) {
      existing.qty += 1;
      render();
      return { added: true, merged: true };
    }

    items.push(newItem);
    render();
    return { added: true, merged: false };
  }

  function remove(rowId) {
    items = items.filter((item) => item.rowId !== rowId);
    render();
  }

  function update(control) {
    const item = items.find((entry) => entry.rowId === Number(control.dataset.row));
    if (!item) return { updated: false, merged: false };

    if (control.dataset.action === "cart-size") item.size = control.value;
    if (control.dataset.action === "cart-color") item.color = control.value;
    if (control.dataset.action === "cart-qty") {
      item.qty = Math.max(1, Number.parseInt(control.value, 10) || 1);
    }

    const merged = mergeDuplicateVariants();
    render();
    return { updated: true, merged };
  }

  function subtotal() {
    return items.reduce((total, item) => {
      const product = getProduct(item.productId);
      return total + (product ? product.price * item.qty : 0);
    }, 0);
  }

  function render() {
    const { elements, formatMoney, escapeHtml } = MIST.ui;
    const totalQuantity = items.reduce((total, item) => total + item.qty, 0);
    elements.navCount.textContent = totalQuantity;

    if (items.length === 0) {
      elements.orderPanel.innerHTML = `
        <div class="order-empty"><p>Your Shopping Bag is empty.</p>
        <a href="#catalogue" class="btn outline">Browse products</a></div>`;
      elements.summaryLines.innerHTML = '<p class="summary-empty">Add products first</p>';
      elements.submitButton.disabled = true;
      return;
    }

    const rows = items.map((item) => {
      const product = getProduct(item.productId);
      if (!product) return "";

      const selectedColor = product.colors[item.color] ? item.color : Object.keys(product.colors)[0];
      item.color = selectedColor;
      const image = product.colors[selectedColor].front;

      const sizeOptions = product.sizes.map((size) =>
        `<option value="${escapeHtml(size)}" ${size === item.size ? "selected" : ""}>${escapeHtml(size)}</option>`
      ).join("");
      const colorOptions = Object.keys(product.colors).map((color) =>
        `<option value="${escapeHtml(color)}" ${color === selectedColor ? "selected" : ""}>${escapeHtml(color)}</option>`
      ).join("");

      return `
        <div class="order-row order-cols">
          <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)} in ${escapeHtml(selectedColor)}">
          <div class="order-item-name">${escapeHtml(product.name)}
            <div class="order-item-price">${formatMoney(product.price)}</div></div>
          <div class="field-size"><select class="order-select" data-action="cart-size" data-row="${item.rowId}" aria-label="Size">${sizeOptions}</select></div>
          <div class="field-colour"><select class="order-select" data-action="cart-color" data-row="${item.rowId}" aria-label="Colour">${colorOptions}</select></div>
          <div class="field-qty"><input type="number" min="1" step="1" inputmode="numeric" class="qty-input" data-action="cart-qty" data-row="${item.rowId}" value="${item.qty}" aria-label="Quantity"></div>
          <div class="price-remove"><span class="line-total">${formatMoney(product.price * item.qty)}</span>
            <button type="button" class="remove-btn" data-action="cart-remove" data-row="${item.rowId}">Remove</button></div>
        </div>`;
    }).join("");

    elements.orderPanel.innerHTML = `
      <div class="order-cols order-header"><div></div><div></div><div class="col-label">Size</div>
      <div class="col-label">Colour</div><div class="col-label">Qty</div><div></div></div>
      ${rows}
      <div class="order-summary-block"><div class="order-summary-row"><span>Estimated product subtotal</span>
      <span class="sub-amt">${formatMoney(subtotal())}</span></div>
      <p class="shipping-note">Shipping is calculated after we confirm your location and stock.</p>
      <a href="#order" class="btn continue-btn">Continue to your details</a></div>`;

    elements.summaryLines.innerHTML = items.map((item) => {
      const product = getProduct(item.productId);
      if (!product) return "";
      return `<div class="summary-line"><span>${escapeHtml(product.name)} (${escapeHtml(item.size)}, ${escapeHtml(item.color)}) × ${item.qty}</span>
      <span>${formatMoney(product.price * item.qty)}</span></div>`;
    }).join("") + `<div class="summary-line summary-total"><span>Estimated subtotal</span><span>${formatMoney(subtotal())}</span></div>`;

    elements.submitButton.disabled = false;
  }

  function payloadItems() {
    return items.map((item) => {
      const product = getProduct(item.productId);
      const sku = skuFor(product, item.color, item.size);
      if (!sku) throw new Error(`Missing SKU mapping for ${product ? product.name : item.productId}`);
      return {
        sku,
        qty: item.qty,
        // Display-only fields. The backend validates official details and price from Products.
        name: product.name,
        size: item.size,
        color: item.color,
        unitPrice: product.price,
        lineTotal: product.price * item.qty,
      };
    });
  }

  function clear() {
    items = [];
    render();
  }

  function isEmpty() {
    return items.length === 0;
  }

  return { initialize, add, remove, update, subtotal, payloadItems, clear, isEmpty };
})();
