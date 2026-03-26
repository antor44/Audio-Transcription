let isCaptureStarting = false;
let isStoppingCapture = false;
let isTranslating = false;

let translatedContextWindow = [];
let recentOriginalFragments = [];

const MAX_CONTEXT_SIZE = 2;
const MAX_RECENT_ORIGINALS = 20;
const STARTUP_FLAG_KEY = "browserJustStarted";

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function getStorageValue(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result ? result[key] : undefined));
  });
}

function setStorage(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(null);
      return;
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(null);
      return;
    }

    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function executeScriptInTab(tabId, file) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(false);
      return;
    }

    try {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: [file]
        },
        () => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(true);
        }
      );
    } catch (e) {
      resolve(false);
    }
  });
}

function removeChromeTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve();
      return;
    }

    try {
      chrome.tabs.remove(tabId, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function safeSendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function splitWords(text) {
  return normalizeText(text).toLowerCase().split(" ").filter(Boolean);
}

function textSimilarity(a, b) {
  const wa = splitWords(a);
  const wb = splitWords(b);

  if (!wa.length || !wb.length) return 0;

  const setA = new Set(wa);
  let matches = 0;
  for (const word of wb) {
    if (setA.has(word)) matches++;
  }

  return matches / Math.max(wa.length, wb.length);
}

function overlapSuffixPrefix(baseText, nextText, maxWords = 40, minWords = 3) {
  const a = splitWords(baseText);
  const b = splitWords(nextText);
  const max = Math.min(maxWords, a.length, b.length);

  for (let size = max; size >= minWords; size--) {
    let ok = true;
    for (let i = 0; i < size; i++) {
      if (a[a.length - size + i] !== b[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return size;
  }

  return 0;
}

// Spaceless-script detector for translation-output dedup and prompt context.
// Same character ranges as SPACELESS_RE in content.js; duplicated here so
// background.js remains self-contained (no shared module needed).
const SPACELESS_RE_BG =
  /[\u3040-\u9FFF\uF900-\uFAFF\u0E00-\u0E7F\u1000-\u109F\u1780-\u17FF]/;

function trimTranslatedPrefixOverlap(previousText, newText) {
  // Primary path: word-overlap deduplication for space-separated scripts.
  const prev    = splitWords(previousText);
  const rawNew  = normalizeText(newText).split(/\s+/).filter(Boolean);
  const normNew = splitWords(newText);
  const max = Math.min(30, prev.length, normNew.length);

  for (let size = max; size >= 3; size--) {
    let ok = true;
    for (let i = 0; i < size; i++) {
      if (prev[prev.length - size + i] !== normNew[i]) { ok = false; break; }
    }
    if (ok) return rawNew.slice(size).join(" ").trim();
  }

  // Fallback for spaceless-script output (e.g. translating INTO Japanese/Chinese):
  // word-split produces one huge token, so use character-level overlap instead.
  if (SPACELESS_RE_BG.test(normalizeText(newText))) {
    const prevFlat = normalizeText(previousText).replace(/\s+/g, "").slice(-60);
    const newFlat  = normalizeText(newText).replace(/\s+/g, "");
    for (let len = Math.min(40, newFlat.length); len >= 3; len--) {
      if (prevFlat.endsWith(newFlat.slice(0, len))) {
        return normalizeText(newText).slice(len);
      }
    }
  }

  return normalizeText(newText);
}

function resetTranslationContext() {
  translatedContextWindow = [];
  recentOriginalFragments = [];
  try {
    chrome.tts.stop();
  } catch (e) {}
}


// --- Google Translate via unofficial endpoint (no API key needed) ---
async function translateWithGoogle(text, targetLangCode) {
  const input = normalizeText(text);
  if (input.length < 3) return "";

  try {
    const url = new URL("https://clients5.google.com/translate_a/t");
    url.searchParams.set("client", "dict-chrome-ex");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", targetLangCode);
    url.searchParams.set("q", input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) return "";
      const data = await response.json();
      // Response structure: [["translated", "original"]] or {sentences:[{trans,orig}]}
      let result = "";
      if (Array.isArray(data) && Array.isArray(data[0])) {
        result = data.map(item => (Array.isArray(item) ? item[0] : "")).join("");
      } else if (data?.sentences) {
        result = data.sentences.map(s => s.trans || "").join("");
      }
      return normalizeText(result);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn("Google Translate fallback failed:", e);
    return "";
  }
}

// Build generation config and optional thinking config based on model name.
// API schema differs by model family:
//   - gemini-3.x models use thinkingLevel (string: "none"|"minimal"|"low")
//   - gemini-2.5 models use thinkingBudget (integer tokens)
// These are NOT interchangeable — sending the wrong schema is silently ignored
// or may cause errors.
function _buildGenerationConfig(model) {
  let thinkingConfig = null;

  if (model.match(/gemini-3(\.\d+)?.*pro/i)) {
    // gemini-3.x-pro: thinkingLevel string API. "low" is the minimum accepted
    // value that reliably works for Pro variants.
    thinkingConfig = { thinkingLevel: "low" };
  } else if (model.match(/gemini-3(\.\d+)?.*flash.*lite/i)) {
    thinkingConfig = { thinkingLevel: "minimal" };
  } else if (model.match(/gemini-3(\.\d+)?.*flash/i)) {
    thinkingConfig = { thinkingLevel: "minimal" };
  } else if (model.match(/gemini-2\.5.*pro/i)) {
    // gemini-2.5-pro: thinkingBudget integer API. Budget:0 is unreliable per
    // known API issues; 128 is a pragmatic low value that is honoured.
    thinkingConfig = { thinkingBudget: 128 };
  } else if (model.match(/gemini-2\.5.*flash/i)) {
    thinkingConfig = { thinkingBudget: 0 };
  }

  // 1024 tokens gives enough headroom for a ~400-char source batch translated
  // into any language. The previous value of 256 silently truncated larger
  // batches (fast CJK streams), producing partial translation output.
  const generationConfig = { temperature: 0.1, maxOutputTokens: 1024 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  return generationConfig;
}

const SAFETY_SETTINGS_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

// Returns true if the model is a large/slow Pro variant that warrants
// stricter timeouts to fail-fast to Google Translate.
function _isProModel(model) {
  return /pro/i.test(model);
}

async function _geminiAttempt(prompt, model, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isGemma = model.includes("gemma");
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      safetySettings: SAFETY_SETTINGS_OFF
    };
    if (!isGemma) {
      body.generationConfig = _buildGenerationConfig(model);
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || response.statusText || "Fetch error";
      console.error(`Gemini HTTP ${response.status} for model "${model}":`, errorMsg, errorData);
      throw new Error(`Gemini HTTP ${response.status}: ${errorMsg}`);
    }

    const data = await response.json();

    // Thinking models (e.g. gemini-3.1-pro-preview) return multiple parts:
    // the first part(s) may be internal thoughts (thought:true), and the
    // actual translation is in the last non-thought part. Reading only
    // parts[0] silently returns empty for these models.
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought && typeof p.text === "string" && p.text.trim()) || parts[0];
    return normalizeText(textPart?.text || "");
  } finally {
    clearTimeout(timer);
  }
}

// Build prompt: correction mode when source language == target language,
// translation mode otherwise.
function _buildPrompt(input, langName, isCorrection, shownTail) {
  const strictRule =
    "Output ONLY the plain subtitle text. " +
    "No explanations, no notes, no markdown, no introductory phrases, " +
    "no 'Aquí tienes', no corrections commentary, no asterisks. " +
    "Do NOT add, invent or infer any content not present verbatim in the input. " +
    "Just the raw text a human subtitle editor would write.";

  if (isCorrection) {
    return (
      `${strictRule}\n` +
      `Task: Fix ONLY punctuation, spelling, and grammar in ${langName}. ` +
      `Do NOT change, replace or paraphrase any word. Every word in the input must appear in the output. ` +
      `If a word seems wrong or odd, keep it exactly as-is.\n` +
      `Input: ${input}`
    );
  }

  const rawAnchor = shownTail || translatedContextWindow.join(" ");
  let anchor = "";
  if (rawAnchor) {
    // For spaceless-script context (CJK, Thai…) split(/\s+/) produces one huge
    // token — use the last N raw characters instead.
    if (SPACELESS_RE_BG.test(rawAnchor)) {
      anchor = rawAnchor.replace(/\s+/g, "").slice(-20);
    } else {
      anchor = rawAnchor.split(/\s+/).filter(Boolean).slice(-4).join(" ");
    }
  }

  if (anchor) {
    return (
      `${strictRule}\n` +
      `Task: Translate the New Text to ${langName}.\n` +
      `Context (previously translated end): "... ${anchor}"\n` +
      `Output ONLY the translation of the New Text. Do NOT translate or include the Context in your output.\n` +
      `New Text: ${input}`
    );
  }

  return (
    `${strictRule}\n` +
    `Task: Translate the text to ${langName}.\n` +
    `Input: ${input}`
  );
}

async function translateWithGemini(originalText, targetLangCode, model, apiKey, sourceLangCode, shownTail) {
  const input = normalizeText(originalText);
  if (!apiKey || input.length < 3) return "";

  let langName = targetLangCode;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    langName = displayNames.of(targetLangCode) || targetLangCode;
  } catch (e) {}

  const isCorrection = !!(sourceLangCode &&
    sourceLangCode !== "auto" && sourceLangCode !== "" &&
    sourceLangCode === targetLangCode);

  const prompt = _buildPrompt(input, langName, isCorrection, shownTail);

  // Pro models think before answering and can take 5-8 s easily.
  // Strategy: 1 long attempt (8 s) instead of 2 short ones that always expire.
  // Non-Pro models (flash, flash-lite): 2 attempts × 4 s each (max 8 s total).
  const isPro = _isProModel(model);

  let translated = "";
  let geminiError = ""; // captures actual API error reason for the status bar

  if (isPro) {
    try {
      translated = await _geminiAttempt(prompt, model, apiKey, 8000);
    } catch (e) {
      geminiError = e.name === "AbortError" ? `${model}: timeout (8s)` : `${model}: ${e.message}`;
      console.warn("Gemini Pro attempt failed:", geminiError);
    }
  } else {
    try {
      translated = await _geminiAttempt(prompt, model, apiKey, 4000);
    } catch (e) {
      geminiError = e.name === "AbortError" ? `${model}: timeout (4s)` : `${model}: ${e.message}`;
      console.warn("Gemini attempt 1 failed:", geminiError);
    }
    if (!translated) {
      try {
        translated = await _geminiAttempt(prompt, model, apiKey, 4000);
      } catch (e) {
        if (!geminiError) geminiError = e.name === "AbortError" ? `${model}: timeout (4s)` : `${model}: ${e.message}`;
        console.warn("Gemini attempt 2 failed:", geminiError);
      }
    }
  }

  let usedFallback = false;
  if (!translated) {
    console.warn("Gemini unavailable, trying Google Translate fallback...");
    translated = await translateWithGoogle(input, targetLangCode);
    if (translated) usedFallback = true;
  }

  if (!translated) return { text: "", geminiError };

  const contextEntry = shownTail
    ? shownTail.split(/\s+/).filter(Boolean).slice(-20).join(" ") + " " + translated
    : translated;
  translatedContextWindow.push(contextEntry);
  if (translatedContextWindow.length > MAX_CONTEXT_SIZE) {
    translatedContextWindow.shift();
  }

  const text = usedFallback ? `\u207A ${translated}` : translated;
  return { text, geminiError: usedFallback ? geminiError : "" };
}

function speakText(text, lang) {
  const clean = normalizeText(text);
  if (!clean) return;

  chrome.storage.local.get(["ttsSpeed"], (res) => {
    const rate = Number.parseFloat(res?.ttsSpeed || "1.0");
    const options = {
      rate: Number.isFinite(rate) ? rate : 1.0,
      pitch: 1.0,
      volume: 1.0,
      enqueue: true
    };

    if (lang && lang.trim() !== "" && lang.trim() !== "AUTO") {
      options.lang = lang;
    }

    try {
      chrome.tts.speak(clean, options);
    } catch (e) {
      console.error("TTS error:", e);
    }
  });
}

function setCapturingState(isCapturing) {
  chrome.storage.local.set({
    capturingState: { isCapturing: !!isCapturing },
    isCapturing: !!isCapturing
  });
  safeSendRuntimeMessage({ action: "toggleCaptureButtons", isCapturing: !!isCapturing });
}

function notifyLanguage(detectedLanguage) {
  safeSendRuntimeMessage({
    action: "updateSelectedLanguage",
    detectedLanguage: detectedLanguage || null
  });
}

function openOptionsTab() {
  return new Promise((resolve) => {
    chrome.tabs.create(
      {
        pinned: true,
        active: false,
        url: `chrome-extension://${chrome.runtime.id}/options.html`
      },
      (tab) => resolve(tab || null)
    );
  });
}

function openStandaloneWindow() {
  return new Promise((resolve) => {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL("standalone.html"),
        type: "popup",
        width: 920,
        height: 360
      },
      (win) => {
        const tabId = win?.tabs?.[0]?.id || null;
        resolve(tabId);
      }
    );
  });
}

async function stopCaptureInternal() {
  if (isStoppingCapture) return;
  isStoppingCapture = true;

  try { chrome.tts.stop(); } catch (e) {}

  try {
    const storageKeys = [
      "optionTabId",
      "currentTabId",
      "standaloneTabId",
      "captureSourceTabId"
    ];
    const storage = await getStorage(storageKeys);

    const idsToStop = Array.from(
      new Set(
        [
          storage.captureSourceTabId,
          storage.currentTabId,
          storage.standaloneTabId,
          storage.optionTabId
        ].filter(Boolean)
      )
    );

    await Promise.all(
      idsToStop.map((id) =>
        sendMessageToTab(id, { type: "STOP" }).catch((err) =>
          console.log(`Stop message failed for tab ${id}:`, err)
        )
      )
    );

    await delay(100);

    const closePromises = [];
    if (storage.standaloneTabId) {
      closePromises.push(removeChromeTab(storage.standaloneTabId).catch(() => {}));
    }
    if (storage.optionTabId) {
      closePromises.push(removeChromeTab(storage.optionTabId).catch(() => {}));
    }
    await Promise.all(closePromises);

    resetTranslationContext();

    await setStorage({
      optionTabId: null,
      currentTabId: null,
      standaloneTabId: null,
      captureSourceTabId: null
    });

    setCapturingState(false);
  } catch (error) {
    console.error("stopCaptureInternal error:", error);
    setCapturingState(false);
  } finally {
    isStoppingCapture = false;
  }
}

function stopCapture() {
  void Promise.resolve().then(() => stopCaptureInternal());
}

async function startCaptureInternal(options) {
  if (isCaptureStarting) return;
  isCaptureStarting = true;

  try {
    // Always send STOP to the previous source tab before starting a new session.
    // capturingState.isCapturing can already be false (PiP activation, network
    // drop, stream inactivity) while the content-script overlay is still alive.
    // Sending STOP unconditionally closes any orphaned overlay.
    const prevSourceTabId = await getStorageValue("captureSourceTabId");
    if (prevSourceTabId) {
      await sendMessageToTab(prevSourceTabId, { type: "STOP" });
    }

    const currentState = await getStorageValue("capturingState");
    if (currentState?.isCapturing) {
      await stopCaptureInternal();
      await delay(250);
    }

    const sourceTab = await getTab(options.tabId);
    if (!sourceTab) {
      setCapturingState(false);
      return;
    }

    const oldOptionTabId = await getStorageValue("optionTabId");
    if (oldOptionTabId) {
      await removeChromeTab(oldOptionTabId);
      await setStorage({ optionTabId: null });
    }

    const oldStandaloneTabId = await getStorageValue("standaloneTabId");
    if (oldStandaloneTabId) {
      await removeChromeTab(oldStandaloneTabId);
      await setStorage({ standaloneTabId: null });
    }

    if (!options.useStandalone) {
      const injected = await executeScriptInTab(sourceTab.id, "content.js");
      if (!injected) {
        throw new Error("Failed to inject content.js");
      }

      await delay(120);
      await sendMessageToTab(sourceTab.id, { type: "resetSession" });
      await setStorage({
        currentTabId: sourceTab.id,
        captureSourceTabId: sourceTab.id
      });
    } else {
      await setStorage({
        captureSourceTabId: sourceTab.id
      });
    }

    const optionTab = await openOptionsTab();
    if (!optionTab?.id) {
      throw new Error("Failed to open options.html");
    }

    await setStorage({ optionTabId: optionTab.id });
    await delay(300);

    const {
      selectedLanguage,
      selectedTask,
      selectedModelSize
    } = await getStorage([
      "selectedLanguage",
      "selectedTask",
      "selectedModelSize"
    ]);

    const startMessage = {
      type: "start_capture",
      data: {
        currentTabId: sourceTab.id,
        host: options.host || "localhost",
        port: options.port || "9090",
        multilingual: !!options.useMultilingual,
        language: selectedLanguage || null,
        task: selectedTask || "transcribe",
        modelSize: selectedModelSize || "small",
        useVad: !!options.useVad,
        useStandalone: !!options.useStandalone
      }
    };

    const started = await sendMessageToTab(optionTab.id, startMessage);
    if (!started || started.success === false) {
      throw new Error("Failed to start capture in options.js");
    }

    if (options.useStandalone) {
      setCapturingState(true);

      const standaloneTabId = await openStandaloneWindow();
      if (!standaloneTabId) {
        throw new Error("Failed to open standalone window");
      }

      await setStorage({
        standaloneTabId,
        currentTabId: standaloneTabId
      });

      await delay(500);
      await sendMessageToTab(standaloneTabId, { type: "resetSession" });

      await sendMessageToTab(optionTab.id, {
        type: "update_target",
        data: { currentTabId: standaloneTabId }
      });
    } else {
      setCapturingState(true);
    }
  } catch (error) {
    console.error("startCaptureInternal error:", error);
    await stopCaptureInternal();
    setCapturingState(false);
  } finally {
    isCaptureStarting = false;
  }
}

function startCapture(options) {
  void Promise.resolve().then(() => startCaptureInternal(options));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.action === "startCapture") {
      startCapture(message);
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "stopCapture") {
      stopCapture();
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "toggleCaptureButtons") {
      const isCapturing =
        typeof message.isCapturing === "boolean"
          ? message.isCapturing
          : typeof message.data === "boolean"
          ? message.data
          : false;

      setCapturingState(isCapturing);
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "updateSelectedLanguage") {
      const detectedLanguage = message.detectedLanguage || null;
      chrome.storage.local.set({ selectedLanguage: detectedLanguage });
      notifyLanguage(detectedLanguage);
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "resetTranslationContext") {
      resetTranslationContext();
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "stopTts") {
      try { chrome.tts.stop(); } catch (e) {}
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "pageUnloading") {
      sendResponse({ success: true });
      return false;
    }

    if (message.action === "speakOriginalText") {
      getStorage(["enableTts", "selectedTask", "selectedLanguage"]).then((res) => {
        if (!res.enableTts) {
          sendResponse({ success: true });
          return;
        }

        let ttsLang = "";
        if (res.selectedTask === "translate") {
          ttsLang = "en"; 
        } else if (res.selectedLanguage && res.selectedLanguage !== "AUTO") {
          ttsLang = res.selectedLanguage;
        }

        speakText(message.text, ttsLang);
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.action === "processTranslation") {
      getStorage(["geminiApiKey", "geminiModel", "targetLanguage", "enableTts", "selectedLanguage"])
        .then(async (res) => {
          const targetLang = res.targetLanguage || "es";
          const apiKey    = res.geminiApiKey || "";
          const model     = res.geminiModel || "gemini-3.1-flash-lite-preview";
          const sourceLang = res.selectedLanguage || "";
          const shownTail  = normalizeText(message.shownTail || "");

          let translated = "";

          if (model === "google-translate") {
            translated = await translateWithGoogle(message.text, targetLang);
          } else if (!apiKey) {
            // No Gemini API key configured — fall back to Google Translate silently
            // instead of surfacing an error that blocks all future translation.
            console.warn("Gemini API key not set, falling back to Google Translate.");
            translated = await translateWithGoogle(message.text, targetLang);
            if (translated) translated = "\u207A " + translated; // prefix ⁺ to signal fallback
          } else {
            try {
              const result = await translateWithGemini(message.text, targetLang, model, apiKey, sourceLang, shownTail);
              // translateWithGemini returns {text, geminiError} so the status bar
              // can show the real API failure reason when Gemini falls back to GT.
              translated = result?.text ?? result ?? "";
              const geminiError = result?.geminiError || "";
              if (res.enableTts && translated) {
                const ttsText = translated.replace(/^\u207A\s*/, "");
                speakText(ttsText, targetLang);
              }
              if (geminiError) {
                // Surface the real Gemini error in the status bar.
                console.warn("Gemini fallback to GT, reason:", geminiError);
                sendResponse({ success: true, data: translated, geminiError });
              } else {
                sendResponse({ success: true, data: translated });
              }
            } catch (e) {
              console.error("translateWithGemini caught:", e);
              sendResponse({ success: false, error: e.message });
            }
            return;
          }

          if (res.enableTts && translated) {
            const ttsText = translated.replace(/^\u207A\s*/, "");
            speakText(ttsText, targetLang);
          }
          sendResponse({ success: true, data: translated || "" });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });

      return true;
    }

    sendResponse({ success: false, error: "Unknown action" });
    return false;
  } catch (e) {
    console.error("Runtime message error:", e);
    sendResponse({ success: false, error: e.message });
    return false;
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ [STARTUP_FLAG_KEY]: true });
  setTimeout(() => {
    chrome.storage.local.remove(STARTUP_FLAG_KEY);
  }, 10000);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(
    ["optionTabId", "currentTabId", "standaloneTabId", "captureSourceTabId", "capturingState"],
    (result) => {
      if (!result?.capturingState?.isCapturing) return;

      const tracked = [
        result.optionTabId,
        result.currentTabId,
        result.standaloneTabId,
        result.captureSourceTabId
      ].filter(Boolean);

      if (tracked.includes(tabId)) {
        try { chrome.tts.stop(); } catch (e) {}
        stopCapture();
      }
    }
  );
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;

  chrome.storage.local.get(
    ["captureSourceTabId", "standaloneTabId", "capturingState"],
    (result) => {
      if (!result?.capturingState?.isCapturing) return;
      if (result.standaloneTabId) return;

      if (tabId === result.captureSourceTabId) {
        try { chrome.tts.stop(); } catch (e) {}
        stopCapture();
      }
    }
  );
});

self.addEventListener("unhandledrejection", (event) => {
  const message = event?.reason?.message || "";
  if (message.includes("Could not establish connection")) {
    event.preventDefault();
    return true;
  }
});
