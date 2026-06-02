\## 1. Project Overview

* **Name:** Manga OCR Translator Extension
* **Target:** Automatically translate Japanese online manga/webtoon images into Korean using Gemini 1.5 Flash.
* **Core Philosophy:** Cost-efficiency and Performance. Do not process images blindly. Use manual toggle, size filters, and smart queues.

## 2. Technical Stack & Specifications

* **Platform:** Chrome Extension Manifest V3
* **LLM API:** Gemini 1.5 Flash (`gemini-1.5-flash`)
* **Key Components:**
* `manifest.json`: Extension metadata and permissions.
* `popup/` (or `options/`): UI to toggle "Manga Mode" and input Gemini API Key.
* `background.js`: Service Worker handling Gemini API calls (to avoid CORS) and caching.
* `content.js`: DOM observer, image size filter, and translation overlay (Inpainting) layer injector.



## 3. Core Features & Implementation Rules

### Rule A: Cost & Performance Optimization (Crucial)

1. **Manual Toggle:** The extension must remain IDLE until the user explicitly turns on "Manga Mode" via the popup UI or a shortcut (`Ctrl+Shift+Y`).
2. **Size Filtering:** Only intercept `<img>` or `<canvas>` elements where:
* $\text{Width} \ge 500\text{px}$ AND $\text{Height} \ge 500\text{px}$
* OR $\text{Total Area} \ge 250,000\text{px}^2$.


3. **Observation Method:** Use `IntersectionObserver` to detect when eligible images enter the viewport. Do not send off-screen images to the API immediately; use a lazy-load approach.

### Rule B: Gemini API Interaction & Prompt Engineering

1. **API Handling:** `content.js` captures the image source, converts it to Base64 (if necessary), and sends a message to `background.js`. `background.js` executes the fetch request to the Gemini API using the user's stored API Key.
2. **Strict System Prompt:**
```text
You are an expert Japanese-to-Korean Manga translator and OCR engine.
Analyze the provided image, detect all Japanese text inside speech bubbles, and translate them into natural, conversational Korean.

CRITICAL: You must return the output STRICTLY in the following JSON format. Do not include markdown blocks like ```json ... 

```



```. Just raw JSON text.
   
   [
     {
       "box_2d": [ymin, xmin, ymax, xmax], 
       "text": "번역된 한국어 문장"
     }
   ]
   * Note: The box_2d coordinates must be normalized relative numbers (0 to 1000) representing the bounding box of the speech bubble.

```

### Rule C: UI Overlay (Inpainting)

1. Once `content.js` receives the JSON response containing coordinates and translated text:

* Calculate absolute positioning relative to the target image's current display size.
* Inject a `div` mask over the original Japanese text (Background: White or matching color, solid).
* Render the Korean text neatly inside the mask, centering it horizontally and vertically.
* Ensure text resizes dynamically if the browser window resizes.

## 4. Expected Directory Structure

```text
├── manifest.json
├── popup.html
├── popup.js
├── background.js
├── content.js
├── content.css
└── agent.md (This file)

```

## 5. Next Steps for Agent

1. Generate a robust `manifest.json` using Manifest V3 featuring `storage` and `activeTab` permissions.
2. Write `content.js` focusing on the `IntersectionObserver` and the dynamic absolute positioning overlay calculation.
3. Write `background.js` to securely send the image data to Gemini API and manage basic memory caching to prevent translating the same image twice.

---


```

```
