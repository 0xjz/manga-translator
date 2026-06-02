'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let isActive = false;
let intersectionObserver = null;
let mutationObserver = null;

const processedKeys = new Set();
// el -> rendered canvas (for cleanup)
const elementCanvases = new WeakMap();

// ─── Size filter ──────────────────────────────────────────────────────────────

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

// ─── Canvas rendering ─────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Replaces el (img or canvas) with a canvas that has:
 *   - the full original image drawn at natural resolution
 *   - each speech bubble filled white (Japanese text covered)
 *   - Korean text drawn directly onto the canvas
 */
async function renderWithCanvas(el, translations, b64, mimeType) {
  const srcImg = await loadImage(`data:${mimeType};base64,${b64}`);

  const nw = srcImg.naturalWidth;
  const nh = srcImg.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.className = 'manga-canvas';
  canvas.width  = nw;
  canvas.height = nh;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(srcImg, 0, 0);

  for (const { box_2d, text } of translations) {
    const [ymin, xmin, ymax, xmax] = box_2d;

    const bx = (xmin / 1000) * nw;
    const by = (ymin / 1000) * nh;
    const bw = ((xmax - xmin) / 1000) * nw;
    const bh = ((ymax - ymin) / 1000) * nh;

    // Detect orientation: tall & narrow → vertical (세로쓰기)
    const isVertical = bh > bw * 1.2;
    const fontSize   = fitFontSize(ctx, text, bw, bh, isVertical);
    ctx.font         = `${fontSize}px "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Measure actual Korean text size → minimal white fill
    const { tw, th } = measureTextBounds(ctx, text, bw, bh, fontSize, isVertical);
    const pad  = Math.max(3, fontSize * 0.25);
    const fillW = Math.min(tw + pad * 2, bw);
    const fillH = Math.min(th + pad * 2, bh);
    const fillX = bx + (bw - fillW) / 2;
    const fillY = by + (bh - fillH) / 2;

    ctx.fillStyle = '#fff';
    ctx.fillRect(fillX, fillY, fillW, fillH);

    ctx.fillStyle = '#111';
    if (isVertical) {
      drawVertical(ctx, text, fillX, fillY, fillW, fillH, fontSize);
    } else {
      drawHorizontal(ctx, text, fillX, fillY, fillW, fillH, fontSize);
    }
  }

  // CSS: behave exactly like the original img (auto aspect-ratio via canvas intrinsic size)
  canvas.style.cssText = `max-width:100%;height:auto;display:${getComputedStyle(el).display || 'block'};`;

  el.insertAdjacentElement('beforebegin', canvas);
  el.style.display = 'none';
  el.dataset.mangaDone = '1';
  elementCanvases.set(el, canvas);
}

// ─── Text measurement ────────────────────────────────────────────────────────

function measureTextBounds(ctx, text, bw, bh, fontSize, isVertical) {
  if (isVertical) {
    const lineH   = fontSize * 1.35;
    const charW   = fontSize * 1.1;
    const maxRows = Math.max(1, Math.floor(bh / lineH));
    const cols    = Math.ceil(text.length / maxRows);
    return { tw: cols * charW, th: Math.min(text.length, maxRows) * lineH };
  }
  const lineH = fontSize * 1.4;
  const maxW  = bw - fontSize * 0.4;
  let line = '', lineCount = 0, maxMeasured = 0;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      maxMeasured = Math.max(maxMeasured, ctx.measureText(line).width);
      lineCount++;
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) { maxMeasured = Math.max(maxMeasured, ctx.measureText(line).width); lineCount++; }
  return { tw: maxMeasured, th: lineCount * lineH };
}

// ─── Font sizing ──────────────────────────────────────────────────────────────

function fitFontSize(ctx, text, bw, bh, isVertical) {
  if (isVertical) {
    // Single char column: font ≈ column width
    return clamp(Math.floor(bw * 0.72), 11, 44);
  }
  // Start from area estimate, then shrink until text fits one line or wraps acceptably
  const areaGuess = Math.floor(Math.sqrt((bw * bh) / Math.max(text.length, 1)) * 1.15);
  return clamp(areaGuess, 11, 44);
}

// ─── Vertical text (manga 세로쓰기, columns RTL) ──────────────────────────────

function drawVertical(ctx, text, bx, by, bw, bh, fontSize) {
  const lineH = fontSize * 1.35;
  const charW = fontSize * 1.1;
  const maxRows = Math.max(1, Math.floor(bh / lineH));

  // First column at the right edge, subsequent columns to the left
  const startX = bx + bw - charW * 0.5;

  [...text].forEach((ch, i) => {
    const col = Math.floor(i / maxRows);
    const row = i % maxRows;
    const x = startX - col * charW;
    if (x < bx) return; // overflow guard
    ctx.fillText(ch, x, by + lineH * row + lineH * 0.5);
  });
}

// ─── Horizontal text with character-level wrapping ────────────────────────────

function drawHorizontal(ctx, text, bx, by, bw, bh, fontSize) {
  const lineH  = fontSize * 1.4;
  const maxW   = bw - fontSize * 0.4;
  const lines  = [];
  let   line   = '';

  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const totalH = lines.length * lineH;
  const startY = by + (bh - totalH) / 2 + lineH * 0.5;
  lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, startY + i * lineH));
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
  if (el.style.display === 'none') return; // already replaced

  const key = getKey(el);
  if (!key || processedKeys.has(key)) return;
  processedKeys.add(key);

  let localB64 = null;
  let msg;

  if (el.tagName === 'CANVAS') {
    try {
      localB64 = el.toDataURL('image/jpeg', 0.85).split(',')[1];
      msg = { type: 'TRANSLATE_B64', b64: localB64, mimeType: 'image/jpeg', src: key };
    } catch {
      processedKeys.delete(key);
      return;
    }
  } else {
    msg = { type: 'TRANSLATE_URL', src: key };
  }

  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.translations?.length) {
      const b64      = res.b64      ?? localB64;
      const mimeType = res.mimeType ?? 'image/jpeg';
      if (b64) await renderWithCanvas(el, res.translations, b64, mimeType);
    }
  } catch {
    processedKeys.delete(key);
  }
}

// ─── Observers ────────────────────────────────────────────────────────────────

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
    { rootMargin: '300px 0px', threshold: 0.01 }
  );

  document.querySelectorAll('img, canvas').forEach(tryObserve);

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
  document.querySelectorAll('[data-manga-done]').forEach(el => {
    el.style.display = '';
    delete el.dataset.mangaDone;
    elementCanvases.get(el)?.remove();
  });
  document.querySelectorAll('.manga-canvas').forEach(c => c.remove());
  processedKeys.clear();
}

// ─── Activation ───────────────────────────────────────────────────────────────

function activate() {
  isActive = true;
  setupObservers();
}

function deactivate() {
  isActive = false;
  teardownObservers();
  clearAll();
}

// ─── Messages ─────────────────────────────────────────────────────────────────

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
