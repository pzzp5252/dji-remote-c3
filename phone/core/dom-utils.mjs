// Incremental anti-flicker DOM helpers & keyed list reconcilers.

export function setTextIfChanged(node, text) {
  if (!node) return;
  const str = String(text ?? '');
  if (node.textContent !== str) {
    node.textContent = str;
  }
}

export function setHiddenIfChanged(node, hidden) {
  if (!node) return;
  const next = Boolean(hidden);
  if (node.hidden !== next) {
    node.hidden = next;
  }
}

export function setDisabledIfChanged(node, disabled) {
  if (!node) return;
  const next = Boolean(disabled);
  if (node.disabled !== next) {
    node.disabled = next;
  }
}

export function setAttrIfChanged(node, name, value) {
  if (!node) return;
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const str = value === true ? '' : String(value);
  if (node.getAttribute(name) !== str) {
    node.setAttribute(name, str);
  }
}

export function setDataIfChanged(node, key, value) {
  if (!node) return;
  if (value === null || value === undefined) {
    if (key in node.dataset) delete node.dataset[key];
    return;
  }
  const str = String(value);
  if (node.dataset[key] !== str) {
    node.dataset[key] = str;
  }
}

export function setClassIfChanged(node, className, force) {
  if (!node) return;
  const next = Boolean(force);
  if (node.classList.contains(className) !== next) {
    node.classList.toggle(className, next);
  }
}

export function reconcileChildOrder(container, desiredNodes) {
  if (!container) return;
  const current = Array.from(container.children);
  if (current.length === desiredNodes.length && current.every((node, idx) => node === desiredNodes[idx])) {
    return;
  }
  const desiredSet = new Set(desiredNodes);
  for (const child of current) {
    if (!desiredSet.has(child)) {
      child.remove();
    }
  }
  for (let i = 0; i < desiredNodes.length; i++) {
    const node = desiredNodes[i];
    const existingAtPos = container.children[i];
    if (existingAtPos !== node) {
      container.insertBefore(node, existingAtPos || null);
    }
  }
}

/**
 * Reconciles a keyed list of items inside `container` using `cacheMap`.
 * Preserves existing DOM nodes, their focus, and internal interactive state.
 */
export function reconcileKeyedList(container, items, cacheMap, getKey, createEntry, updateEntry, getNode = entry => entry.el ?? entry) {
  if (!container) return;
  const desiredNodes = [];
  const activeKeys = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = getKey(item, i);
    activeKeys.add(key);
    let entry = cacheMap.get(key);
    if (!entry) {
      entry = createEntry(item, key, i);
      cacheMap.set(key, entry);
    }
    updateEntry(entry, item, i);
    desiredNodes.push(getNode(entry));
  }
  for (const key of Array.from(cacheMap.keys())) {
    if (!activeKeys.has(key)) {
      cacheMap.delete(key);
    }
  }
  reconcileChildOrder(container, desiredNodes);
}
