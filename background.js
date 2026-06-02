'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent';

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

const CACHE_MAX = 200;

// ─── In-memory cache (cleared when service worker restarts) ──────────────────

const cache = new Map();

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
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
  // Strip accidental markdown fences the model sometimes adds despite the prompt
  const clean = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array JSON');
  return parsed;
}

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleTranslate(msg) {
  const cacheKey = msg.src;

  if (cache.has(cacheKey)) {
    return { translations: cache.get(cacheKey), cached: true };
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

  const translations = await callGemini(b64, mimeType, apiKey);
  cacheSet(cacheKey, translations);
  return { translations };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'TRANSLATE_URL' && msg.type !== 'TRANSLATE_B64') return false;

  handleTranslate(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ translations: [], error: err.message }));

  return true; // keep the message channel open for the async response
});

// ─── Keyboard shortcut relay ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-manga-mode') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Ask the content script for the current state, then flip it
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError) return;
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', active: !res?.isActive });
  });
});
