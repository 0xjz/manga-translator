'use strict';

const toggle          = document.getElementById('toggle');
const apiKeyEl        = document.getElementById('apiKey');
const inpaintServerEl = document.getElementById('inpaintServer');
const statusEl        = document.getElementById('status');

// ─── Load persisted state ─────────────────────────────────────────────────────

chrome.storage.local.get(['geminiApiKey', 'inpaintServerUrl'], ({ geminiApiKey, inpaintServerUrl }) => {
  if (geminiApiKey)    apiKeyEl.value        = geminiApiKey;
  if (inpaintServerUrl) inpaintServerEl.value = inpaintServerUrl;
});

// Toggle 상태는 현재 탭에서 직접 조회 (탭마다 독립적)
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError) return;
    toggle.checked = !!res?.isActive;
  });
});

// ─── Toggle ───────────────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  const active = toggle.checked;

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', active }, (res) => {
      if (chrome.runtime.lastError) {
        showStatus('페이지를 새로고침 후 다시 시도하세요.', true);
        toggle.checked = !active; // revert
      }
    });
  });
});

// ─── API Key ──────────────────────────────────────────────────────────────────

let saveTimer;
apiKeyEl.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const key = apiKeyEl.value.trim();
    chrome.storage.local.set({ geminiApiKey: key });
    showStatus(key ? 'API 키 저장됨.' : 'API 키가 삭제되었습니다.');
  }, 600);
});

// ─── Inpaint Server URL ───────────────────────────────────────────────────────

let serverTimer;
inpaintServerEl.addEventListener('input', () => {
  clearTimeout(serverTimer);
  serverTimer = setTimeout(() => {
    const url = inpaintServerEl.value.trim().replace(/\/$/, '');
    chrome.storage.local.set({ inpaintServerUrl: url || null });
    showStatus(url ? '서버 URL 저장됨.' : '인페인트 서버 해제됨.');
  }, 600);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#dc2626' : '#4f46e5';
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => { statusEl.textContent = ''; }, 3000);
}
