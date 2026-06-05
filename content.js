'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let isActive = false;
let intersectionObserver = null;
let mutationObserver = null;

const processedKeys = new Set();
// el -> rendered canvas (for cleanup)
const elementCanvases = new WeakMap();
// canvas element -> key (canvas를 수정하지 않고 식별하기 위한 WeakMap)
const canvasKeys = new WeakMap();
// canvas element -> version number (페이지 이동 중 stale 응답 폐기용)
const canvasVersions = new WeakMap();

function getCanvasKey(el) {
  if (!canvasKeys.has(el)) canvasKeys.set(el, `canvas::${crypto.randomUUID().slice(0, 8)}`);
  return canvasKeys.get(el);
}

// ─── Size filter ──────────────────────────────────────────────────────────────

function isEligibleElement(el) {
  if (el.tagName !== 'IMG') return false;

  // 화면에 실제로 표시되는 크기가 작으면 로고/썸네일로 판단해 제외
  const dw = el.offsetWidth;
  const dh = el.offsetHeight;
  if (dw > 0 && dw < 300) return false;
  if (dh > 0 && dh < 300) return false;

  const w = el.naturalWidth  || dw;
  const h = el.naturalHeight || dh;
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

    const isVertical = false; // 항상 가로 출력
    const fontSize   = fitFontSize(ctx, text, bw, bh, isVertical);
    ctx.font          = `${fontSize}px "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif`;
    ctx.letterSpacing = '-0.3px';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';

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
  // data attribute 세팅 후 DOM 삽입 → MutationObserver가 감지해도 guard에서 차단됨
  canvas.dataset.mangaCanvas = '1';

  el.insertAdjacentElement('beforebegin', canvas);
  el.style.display = 'none';
  el.dataset.mangaDone = '1';
  elementCanvases.set(el, canvas);

  // 망가 리더가 src를 바꿔 다음 페이지를 로드할 경우 캔버스를 제거하고 img 복원
  const srcWatcher = new MutationObserver(() => {
    srcWatcher.disconnect();
    canvas.remove();
    el.style.display = '';
    delete el.dataset.mangaDone;
    processedKeys.delete(el.currentSrc || el.src);
    delete el.dataset.mangaId;
    el.addEventListener('load', () => {
      if (isActive && isEligibleElement(el)) intersectionObserver?.observe(el);
    }, { once: true });
  });
  srcWatcher.observe(el, { attributes: true, attributeFilter: ['src', 'srcset'] });
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
  const MIN = 9, MAX = 24;

  if (isVertical) {
    return clamp(Math.floor(bw * 0.55), MIN, MAX);
  }

  // 면적 기반 초기 추정 (보수적으로 0.8배)
  let size = clamp(Math.floor(Math.sqrt((bw * bh) / Math.max(text.length, 1)) * 0.8), MIN, MAX);
  const maxW = bw - 4;

  // 실제로 텍스트가 박스 높이 안에 들어올 때까지 축소
  for (; size >= MIN; size--) {
    ctx.font         = `${size}px sans-serif`;
    ctx.letterSpacing = '-0.3px';
    const lineH = size * 1.2;
    let line = '', lineCount = 0;
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) { lineCount++; line = ch; }
      else line = test;
    }
    if (line) lineCount++;
    if (lineCount * lineH <= bh) break;
  }
  return Math.max(size, MIN);
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
  ctx.letterSpacing = '-0.3px';
  const lineH  = fontSize * 1.2;
  const maxW   = bw - 4;
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

// ─── Canvas overlay (canvas 기반 망가 리더용) ─────────────────────────────────

function renderCanvasOverlay(sourceCanvas, translations) {
  // 기존 overlay 제거
  sourceCanvas.parentElement?.querySelectorAll('.manga-overlay').forEach(o => o.remove());

  // source canvas의 실제 렌더링 크기를 overlay 버퍼로 사용 → 좌표 1:1 대응
  const dw = sourceCanvas.offsetWidth  || sourceCanvas.width;
  const dh = sourceCanvas.offsetHeight || sourceCanvas.height;

  const overlay = document.createElement('canvas');
  overlay.className   = 'manga-canvas manga-overlay';
  overlay.dataset.mangaCanvas = '1';
  overlay.width  = dw;
  overlay.height = dh;
  // offsetLeft/offsetTop 으로 source canvas 위에 정확히 위치
  overlay.style.cssText = `position:absolute;left:${sourceCanvas.offsetLeft}px;top:${sourceCanvas.offsetTop}px;width:${dw}px;height:${dh}px;pointer-events:none;z-index:10;`;

  const ctx = overlay.getContext('2d');
  const nw  = dw;
  const nh  = dh;

  for (const { box_2d, text } of translations) {
    const [ymin, xmin, ymax, xmax] = box_2d;
    const bx = (xmin / 1000) * nw;
    const by = (ymin / 1000) * nh;
    const bw = ((xmax - xmin) / 1000) * nw;
    const bh = ((ymax - ymin) / 1000) * nh;

    const fontSize = fitFontSize(ctx, text, bw, bh, false);
    ctx.font          = `${fontSize}px "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif`;
    ctx.letterSpacing = '-0.3px';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';

    const { tw, th } = measureTextBounds(ctx, text, bw, bh, fontSize, false);
    const pad   = Math.max(3, fontSize * 0.25);
    const fillW = Math.min(tw + pad * 2, bw);
    const fillH = Math.min(th + pad * 2, bh);
    const fillX = bx + (bw - fillW) / 2;
    const fillY = by + (bh - fillH) / 2;

    ctx.fillStyle = '#fff';
    ctx.fillRect(fillX, fillY, fillW, fillH);
    ctx.fillStyle = '#111';
    drawHorizontal(ctx, text, fillX, fillY, fillW, fillH, fontSize);
  }

  const container = sourceCanvas.parentElement;
  if (container && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  sourceCanvas.insertAdjacentElement('afterend', overlay);
}

async function processCanvasElement(canvas) {
  if (!isActive) return;
  if (canvas.dataset.mangaCanvas) return;

  const key = getCanvasKey(canvas);
  if (processedKeys.has(key)) return;
  processedKeys.add(key);

  // 버전 토큰: 응답 대기 중 canvas가 새 페이지로 교체되면 stale 응답을 폐기
  const version = (canvasVersions.get(canvas) || 0) + 1;
  canvasVersions.set(canvas, version);

  let b64;
  try {
    b64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } catch {
    processedKeys.delete(key);
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_B64', b64, mimeType: 'image/jpeg', src: key,
      overlayMode: true,
    });
    // 응답 오는 사이 페이지가 바뀌었으면 버림
    if (canvasVersions.get(canvas) !== version) return;
    if (res?.translations?.length) {
      renderCanvasOverlay(canvas, res.translations);
    }
  } catch {
    processedKeys.delete(key);
  }
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
  if (el.style.display === 'none') return;  // 숨겨진 원본 img
  if (el.dataset.mangaCanvas) return;        // 우리가 만든 캔버스
  if (el.dataset.mangaDone) return;          // 이미 번역 완료된 원본 img

  const key = getKey(el);
  if (!key || processedKeys.has(key)) return;
  processedKeys.add(key);

  // URL을 service worker로 전달 — service worker가 이미지 fetch + Gemini 호출
  const msg = { type: 'TRANSLATE_URL', src: key };

  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.translations?.length && res.b64) {
      await renderWithCanvas(el, res.translations, res.b64, res.mimeType ?? 'image/jpeg');
    }
  } catch {
    processedKeys.delete(key);
  }
}

// ─── Observers ────────────────────────────────────────────────────────────────

function tryObserve(el) {
  if (el.dataset.mangaCanvas) return;  // 우리가 만든 캔버스는 관찰 제외
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

  document.querySelectorAll('img').forEach(tryObserve);

  // 활성화 시점에 이미 mode-loaded 상태인 페이지도 즉시 처리
  document.querySelectorAll('.mode-loaded, .loaded').forEach(el => {
    el.querySelectorAll('canvas:not([data-manga-canvas])').forEach(processCanvasElement);
  });

  mutationObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      // img 추가 감지 (img 기반 사이트)
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('img')) tryObserve(node);
          node.querySelectorAll?.('img').forEach(tryObserve);
        }
      }
      // class 변경 감지 — "mode-loaded" 등 canvas 로딩 완료 신호 (canvas 기반 사이트)
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if (el.classList.contains('mode-loaded') || el.classList.contains('loaded')) {
          el.querySelectorAll('canvas:not([data-manga-canvas])').forEach(canvas => {
            // 캐시 키 완전 초기화: 같은 canvas 재사용 시 background.js 캐시도 우회
            if (canvasKeys.has(canvas)) {
              processedKeys.delete(canvasKeys.get(canvas));
              canvasKeys.delete(canvas); // 새 UUID 생성 강제 → 새 캐시 키
            }
            canvas.parentElement?.querySelectorAll('.manga-overlay').forEach(o => o.remove());
            processCanvasElement(canvas);
          });
        }
      }
    }
  });

  mutationObserver.observe(document.documentElement, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ['class'],
  });
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
