'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let isActive = false;
let intersectionObserver = null;
let mutationObserver = null;

/** Keys of images already sent for translation (img.src or canvas id). */
const processedKeys = new Set();

/** Stores raw translation data per element so overlays can be redrawn on resize. */
const imageTranslations = new WeakMap();

// ─── Size filter (Rule A-2) ───────────────────────────────────────────────────

function isEligibleElement(el) {
  let w, h;
  if (el.tagName === 'IMG') {
    w = el.naturalWidth  || el.offsetWidth;
    h = el.naturalHeight || el.offsetHeight;
  } else if (el.tagName === 'CANVAS') {
    w = el.width;
    h = el.height;
  } else {
    return false;
  }
  return (w >= 500 && h >= 500) || w * h >= 250_000;
}

// ─── Overlay rendering (Rule C) ───────────────────────────────────────────────

/**
 * Wraps an <img> in a position:relative div so overlays always reference the
 * image's own coordinate space, regardless of the surrounding page layout.
 */
function ensureWrapper(img) {
  if (img.parentElement?.dataset.mangaWrapper) return img.parentElement;

  const wrapper = document.createElement('div');
  wrapper.dataset.mangaWrapper = '1';
  // Preserve block vs inline-block so the page layout stays intact
  const display = getComputedStyle(img).display;
  wrapper.style.display = display === 'inline' ? 'inline-block' : display || 'block';
  img.parentNode.insertBefore(wrapper, img);
  wrapper.appendChild(img);
  return wrapper;
}

function renderOverlays(el, translations) {
  // Canvas elements: make the existing parent relative (wrapping breaks canvas APIs)
  let container;
  if (el.tagName === 'CANVAS') {
    container = el.parentElement;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
  } else {
    container = ensureWrapper(el);
  }

  container.querySelectorAll('.manga-overlay').forEach(o => o.remove());
  if (!translations.length) return;

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // For canvas: overlays sit at el.offsetLeft/Top within the container
  const baseX = el.tagName === 'CANVAS' ? el.offsetLeft : 0;
  const baseY = el.tagName === 'CANVAS' ? el.offsetTop  : 0;

  for (const { box_2d, text } of translations) {
    const [ymin, xmin, ymax, xmax] = box_2d;

    const left   = baseX + (xmin / 1000) * w;
    const top    = baseY + (ymin / 1000) * h;
    const width  = ((xmax - xmin) / 1000) * w;
    const height = ((ymax - ymin) / 1000) * h;

    // Scale font to ~25 % of box height, clamped to a readable range
    const fontSize = Math.max(9, Math.min(16, Math.floor(height * 0.25)));

    const div = document.createElement('div');
    div.className = 'manga-overlay';
    div.textContent = text;
    div.style.left     = `${left}px`;
    div.style.top      = `${top}px`;
    div.style.width    = `${width}px`;
    div.style.height   = `${height}px`;
    div.style.fontSize = `${fontSize}px`;
    container.appendChild(div);
  }
}

/** Redraws all overlays after a window resize. */
function rerenderAll() {
  document.querySelectorAll('[data-manga-done]').forEach(el => {
    const t = imageTranslations.get(el);
    if (t) renderOverlays(el, t);
  });
}

// ─── Processing pipeline ──────────────────────────────────────────────────────

function getKey(el) {
  if (el.tagName === 'CANVAS') {
    if (!el.dataset.mangaId) el.dataset.mangaId = crypto.randomUUID().slice(0, 8);
    return `canvas::${el.dataset.mangaId}`;
  }
  return el.currentSrc || el.src;
}

async function processElement(el) {
  if (!isActive || !isEligibleElement(el)) return;

  const key = getKey(el);
  if (!key || processedKeys.has(key)) return;
  processedKeys.add(key);

  let msg;
  if (el.tagName === 'CANVAS') {
    try {
      const b64 = el.toDataURL('image/jpeg', 0.85).split(',')[1];
      msg = { type: 'TRANSLATE_B64', b64, mimeType: 'image/jpeg', src: key };
    } catch {
      // Canvas is tainted (cross-origin); nothing we can do from content script
      processedKeys.delete(key);
      return;
    }
  } else {
    // Send URL to background.js which fetches without CORS restriction
    msg = { type: 'TRANSLATE_URL', src: key };
  }

  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.translations?.length) {
      imageTranslations.set(el, res.translations);
      renderOverlays(el, res.translations);
      el.dataset.mangaDone = '1';
    }
  } catch {
    // Message channel closed or background not ready — allow retry later
    processedKeys.delete(key);
  }
}

// ─── Observers (Rule A-3) ─────────────────────────────────────────────────────

function tryObserve(el) {
  if (!isEligibleElement(el)) return;
  if (el.tagName === 'IMG' && !el.complete) {
    el.addEventListener('load', () => {
      if (isActive && isEligibleElement(el)) intersectionObserver?.observe(el);
    }, { once: true });
  } else {
    intersectionObserver?.observe(el);
  }
}

function setupObservers() {
  intersectionObserver = new IntersectionObserver(
    entries => entries.forEach(e => { if (e.isIntersecting) processElement(e.target); }),
    // 300 px pre-load margin: start fetching just before the image enters the viewport
    { rootMargin: '300px 0px', threshold: 0.01 }
  );

  // Seed with images already in the DOM
  document.querySelectorAll('img, canvas').forEach(tryObserve);

  // Watch for images injected by the page after initial load (lazy-loading manga readers)
  mutationObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('img, canvas')) tryObserve(node);
        node.querySelectorAll?.('img, canvas').forEach(tryObserve);
      }
    }
  });

  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function teardownObservers() {
  intersectionObserver?.disconnect();
  mutationObserver?.disconnect();
  intersectionObserver = mutationObserver = null;
}

function clearAll() {
  document.querySelectorAll('.manga-overlay').forEach(o => o.remove());
  document.querySelectorAll('[data-manga-done]').forEach(el => {
    delete el.dataset.mangaDone;
  });
  processedKeys.clear();
}

// ─── Activation / deactivation ────────────────────────────────────────────────

function activate() {
  isActive = true;
  setupObservers();
}

function deactivate() {
  isActive = false;
  teardownObservers();
  clearAll();
}

// ─── Resize: reposition overlays ─────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  if (!isActive) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderAll, 200);
});

// ─── Message listener (popup + background command relay) ──────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TOGGLE') {
    msg.active ? activate() : deactivate();
    sendResponse({ isActive });
    return false;
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({ isActive });
    return false;
  }
});

