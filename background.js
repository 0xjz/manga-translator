'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite:generateContent';

const SYSTEM_PROMPT =
  'You are an expert Japanese-to-Korean Manga translator and OCR engine.\n' +
  'Analyze the provided image, detect all Japanese text inside speech bubbles, ' +
  'and translate them into natural, conversational Korean.\n\n' +
  'CRITICAL: You must return the output STRICTLY in the following JSON format. ' +
  'Do not include markdown blocks. Just raw JSON text.\n\n' +
  '[\n' +
  '  {\n' +
  '    "box_2d": [ymin, xmin, ymax, xmax],\n' +
  '    "text": "번역된 한국어 문장"\n' +
  '  }\n' +
  ']\n\n' +
  'box_2d coordinates are normalized integers from 0 to 1000 representing the ' +
  'bounding box of each speech bubble relative to the full image dimensions.';

// Smaller limit since each entry now includes b64 image data
const CACHE_MAX = 50;

// ─── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map();

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

// ─── Image resize (reduces Gemini input tokens) ───────────────────────────────

async function resizeForGemini(b64, mimeType, maxDim = 1000) {
  const blob    = await (await fetch(`data:${mimeType};base64,${b64}`)).blob();
  const bitmap  = await createImageBitmap(blob);
  const { width: sw, height: sh } = bitmap;

  if (sw <= maxDim && sh <= maxDim) {
    bitmap.close();
    return { b64, mimeType };
  }

  const scale = maxDim / Math.max(sw, sh);
  const oc  = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  oc.getContext('2d').drawImage(bitmap, 0, 0, oc.width, oc.height);
  bitmap.close();

  const resized = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ b64: reader.result.split(',')[1], mimeType: 'image/jpeg' });
    reader.onerror = reject;
    reader.readAsDataURL(resized);
  });
}

// ─── Inpaint via iopaint server ───────────────────────────────────────────────

async function getInpaintServerUrl() {
  const { inpaintServerUrl } = await chrome.storage.local.get('inpaintServerUrl');
  return inpaintServerUrl || null;
}

/**
 * Creates a mask PNG (black bg, white where text should be removed)
 * from normalized box_2d coordinates and the original image dimensions.
 */
async function createMaskBlob(b64, mimeType, translations) {
  const blob   = await (await fetch(`data:${mimeType};base64,${b64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  bitmap.close();

  const oc  = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'white';
  for (const { box_2d } of translations) {
    const [ymin, xmin, ymax, xmax] = box_2d;
    ctx.fillRect(
      (xmin / 1000) * w,
      (ymin / 1000) * h,
      ((xmax - xmin) / 1000) * w,
      ((ymax - ymin) / 1000) * h,
    );
  }

  return oc.convertToBlob({ type: 'image/png' });
}

async function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function runInpaint(b64, mimeType, translations, serverUrl) {
  const maskBlob = await createMaskBlob(b64, mimeType, translations);
  const maskB64  = await blobToB64(maskBlob);

  // iopaint expects JSON body with base64-encoded image/mask strings
  const res = await fetch(`${serverUrl}/api/v1/inpaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, mask: maskB64 }),
  });

  if (!res.ok) throw new Error(`Inpaint ${res.status}: ${await res.text().catch(() => '')}`);

  const resultBlob = await res.blob();
  return { b64: await blobToB64(resultBlob), mimeType: 'image/png' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  return geminiApiKey ?? null;
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ b64: reader.result.split(',')[1], mimeType: blob.type || 'image/jpeg' });
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function callGemini(b64, mimeType, apiKey) {
  const body = {
    contents: [{
      parts: [
        { text: SYSTEM_PROMPT },
        { inline_data: { mime_type: mimeType, data: b64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array JSON');
  return parsed;
}

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleTranslate(msg) {
  const cacheKey = msg.src;

  if (cache.has(cacheKey)) {
    // b64는 캐시하지 않음 (메모리 절약) — 캐시 히트 시 content.js가 이미 canvas를 가지고 있음
    const { translations } = cache.get(cacheKey);
    return { translations, cached: true };
  }

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API 키가 설정되지 않았습니다. 팝업에서 Gemini API Key를 입력하세요.');

  let b64, mimeType;
  if (msg.type === 'TRANSLATE_B64') {
    b64      = msg.b64;
    mimeType = msg.mimeType;
  } else {
    ({ b64, mimeType } = await fetchImageAsBase64(msg.src));
  }

  // Resize for Gemini (saves tokens); original b64 kept for canvas rendering
  const { b64: b64Small, mimeType: mimeSmall } = await resizeForGemini(b64, mimeType);
  const translations = await callGemini(b64Small, mimeSmall, apiKey);

  // If iopaint server is configured, remove original text from image
  let renderB64   = b64;
  let renderMime  = mimeType;
  const serverUrl = await getInpaintServerUrl();
  if (serverUrl && Array.isArray(translations) && translations.length > 0) {
    try {
      ({ b64: renderB64, mimeType: renderMime } = await runInpaint(b64, mimeType, translations, serverUrl));
    } catch (err) {
      // Inpaint 실패 시 원본 이미지로 폴백 (흰 박스 방식)
      console.warn('Inpaint failed, falling back to original:', err.message);
    }
  }

  if (Array.isArray(translations)) {
    // 번역 결과만 캐시 (b64는 제외 — 이미지당 수백KB이므로 메모리 압박 방지)
    cacheSet(cacheKey, { translations });
  }

  return {
    translations: Array.isArray(translations) ? translations : [],
    b64: renderB64,
    mimeType: renderMime,
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'TRANSLATE_URL' && msg.type !== 'TRANSLATE_B64') return false;

  handleTranslate(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ translations: [], error: err.message }));

  return true;
});

// ─── Keyboard shortcut relay ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-manga-mode') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError) return;
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', active: !res?.isActive });
  });
});
