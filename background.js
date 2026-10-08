/*
 * background.js — part of Audio Transcription
 * Copyright (C) 2026 Antonio Ruiz
 *
 * This file is part of Audio Transcription.
 *
 * This file includes material derived in part from the upstream browser
 * extension components of collabora/WhisperLive, licensed under the MIT License.
 *
 * Upstream copyright notice:
 * Copyright (c) 2023 Vineet Suryan, Collabora Ltd.
 *
 * Audio Transcription is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Audio Transcription is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Audio Transcription. If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional third-party licensing information, including the preserved MIT
 * notice for upstream WhisperLive-derived material, is provided in
 * THIRD_PARTY_NOTICES.md.
 */

let isCaptureStarting = false;
let isStoppingCapture = false;
let isTranslating = false;
let isSeekInterrupt = false; 

let translatedContextWindow = [];
let recentOriginalFragments = [];

let subtitleTabId = null;
let activeSubtitleUtteranceId = 0;

const MAX_CONTEXT_SIZE = 2;
const MAX_RECENT_ORIGINALS = 20;
const STARTUP_FLAG_KEY = "browserJustStarted";

const TTS_BUFFER_MIN_WORDS    = 12;   
const TTS_BUFFER_MIN_CHARS    = 70;   
const TTS_BUFFER_SILENCE_MS   = 1800; 
let   ttsBuffer               = "";   
let   ttsBufferLang           = "";
let   ttsFlushTimer           = null;

const SPACELESS_RE = /[\u3040-\u9FFF\uF900-\uFAFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF]/;
function isSpacelessScript(text) { return SPACELESS_RE.test(text); }

function delay(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function getStorage(keys) { return new Promise((resolve) => { chrome.storage.local.get(keys, (result) => resolve(result || {})); }); }
function getStorageValue(key) { return new Promise((resolve) => { chrome.storage.local.get([key], (result) => resolve(result ? result[key] : undefined)); }); }
function setStorage(obj) { return new Promise((resolve) => { chrome.storage.local.set(obj, () => resolve()); }); }

function getTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) { resolve(null); return; }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(tab || null);
    });
  });
}

function sendMessageToTab(tabId, message, options) {
  return new Promise((resolve) => {
    if (!tabId) { resolve(null); return; }
    const cb = (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response || null);
    };
    try {
      if (options) chrome.tabs.sendMessage(tabId, message, options, cb);
      else chrome.tabs.sendMessage(tabId, message, cb);
    } catch (e) { resolve(null); }
  });
}

function executeScriptInTab(tabId, file) {
  return new Promise((resolve) => {
    if (!tabId) { resolve(false); return; }
    try {
      chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(true);
      });
    } catch (e) { resolve(false); }
  });
}

// Injects subtitle_tts.js into all frames to support embedded players.
// Falls back to the top frame if cross-frame injection is restricted.
async function injectSubtitleTts(tabId) {
  const allOk = await new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["subtitle_tts.js"] }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (e) { resolve(false); }
  });
  if (allOk) return { ok: true, allFrames: true };
  const topOk = await executeScriptInTab(tabId, "subtitle_tts.js");
  return { ok: topOk, allFrames: false };
}

// Queries all frames for media elements and returns their candidates with scores.
function probeVideoFrames(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          try { return (window.__subtitleTtsApi && window.__subtitleTtsApi.probe) ? window.__subtitleTtsApi.probe() : null; }
          catch (e) { return null; }
        }
      }, (results) => {
        if (chrome.runtime.lastError || !Array.isArray(results)) { resolve([]); return; }
        resolve(results
          .filter((r) => r && r.result && r.result.hasVideo)
          .map((r) => ({ frameId: r.frameId, score: r.result.score || 0, playing: !!r.result.playing })));
      });
    } catch (e) { resolve([]); }
  });
}

// Restrict subtitle fetching to public URLs, blocking local or private network addresses.
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

// Monitors frame changes to follow dynamic players (e.g. iframes created or started upon playback).
// Switches the active frame when a clearly better candidate appears: an actively playing video
// replaces an idle one, and otherwise a candidate must be substantially larger.
let frameFollowTimer = null;
const FRAME_FOLLOW_INTERVAL_MS = 3000;
const FRAME_FOLLOW_MAX_TICKS = 1200;
function stopFrameFollow() { if (frameFollowTimer) { clearInterval(frameFollowTimer); frameFollowTimer = null; } }
function startFrameFollow(tabId, startFrameId, initMsg) {
  stopFrameFollow();
  let currentFrameId = startFrameId;
  let ticks = 0;
  let busy = false;
  frameFollowTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      ticks++;
      if (ticks > FRAME_FOLLOW_MAX_TICKS || subtitleTabId !== tabId || !(await getTab(tabId))) { stopFrameFollow(); return; }
      const found = await probeVideoFrames(tabId);
      if (!found.length) return;
      found.sort((a, b) => b.score - a.score);
      const best = found[0];
      const cur = found.find((f) => f.frameId === currentFrameId);
      const curScore = cur ? cur.score : 0;
      if (best.frameId === currentFrameId || best.score < 500) return;
      const better = !cur || (best.playing && !cur.playing) || best.score > curScore * 2;
      if (!better) return;
      if (currentFrameId !== null) await sendMessageToTab(tabId, { type: "SUBTITLE_TTS_DETACH" }, { frameId: currentFrameId });
      currentFrameId = best.frameId;
      await sendMessageToTab(tabId, { ...initMsg, settings: { ...initMsg.settings, ownDocOnly: true } }, { frameId: best.frameId });
    } finally { busy = false; }
  }, FRAME_FOLLOW_INTERVAL_MS);
}

// Collects a diagnostics snapshot from every frame of a tab (the active tab by default).
// Each frame hosts its own subtitle_tts.js instance, so one snapshot per frame is needed to see
// where a player lives. From the service worker console: await diagnoseSubtitleTts()
// Pass { inject: true } to load the script first (this restarts a running Subtitle TTS session).
async function diagnoseSubtitleTts(options = {}) {
  let tabId = options.tabId;
  if (!tabId) {
    // Pick the most recently used web page tab; the inspector window itself is never a candidate
    const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true }, (r) => resolve(r || [])));
    const web = tabs.filter((t) => /^https?:/i.test(t.url || ""));
    web.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    tabId = web[0] && web[0].id;
  }
  if (!tabId) { console.warn("diagnoseSubtitleTts: no web page tab found; pass { tabId }"); return []; }
  if (options.inject) await injectSubtitleTts(tabId);
  const results = await new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          try {
            const api = window.__subtitleTtsApi;
            return api && api.diagnose ? api.diagnose() : { frame: location.href, isTop: window.top === window, api: false };
          } catch (e) { return { frame: location.href, error: String(e && e.message || e) }; }
        }
      }, (res) => {
        if (chrome.runtime.lastError) { console.warn("diagnoseSubtitleTts:", chrome.runtime.lastError.message); resolve([]); return; }
        resolve(Array.isArray(res) ? res : []);
      });
    } catch (e) { console.warn("diagnoseSubtitleTts:", e && e.message || e); resolve([]); }
  });
  const out = results.map((r) => ({ tabId, frameId: r.frameId, ...r.result }));
  console.log(JSON.stringify(out, null, 2));
  return out;
}
self.diagnoseSubtitleTts = diagnoseSubtitleTts;


// Notifies the initiating frame that TTS playback has finished.
function sendTtsDone(tabId, frameId, utteranceId) {
  if (!tabId) return;
  const msg = { type: "SUBTITLE_TTS_DONE", utteranceId };
  const cb = () => { void chrome.runtime.lastError; };
  try {
    if (typeof frameId === "number") chrome.tabs.sendMessage(tabId, msg, { frameId }, cb);
    else chrome.tabs.sendMessage(tabId, msg, cb);
  } catch (e) {}
}

function removeChromeTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) { resolve(); return; }
    try {
      chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; resolve(); });
    } catch (e) { resolve(); }
  });
}

function safeSendRuntimeMessage(message) {
  try { chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }); } catch (e) {}
}

function normalizeText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function splitWords(text) { return normalizeText(text).toLowerCase().split(" ").filter(Boolean); }

function trimTranslatedPrefixOverlap(previousText, newText) {
  const prev    = splitWords(previousText);
  const rawNew  = normalizeText(newText).split(/\s+/).filter(Boolean);
  const normNew = splitWords(newText);
  const max = Math.min(30, prev.length, normNew.length);

  for (let size = max; size >= 3; size--) {
    let errors = 0;
    const maxErrors = size >= 8 ? 2 : size >= 4 ? 1 : 0;
    for (let i = 0; i < size; i++) {
      if (prev[prev.length - size + i] !== normNew[i]) { 
        errors++; 
        if (errors > maxErrors) break; 
      }
    }
    if (errors <= maxErrors) return rawNew.slice(size).join(" ").trim();
  }

  if (SPACELESS_RE.test(normalizeText(newText))) {
    const prevFlat = normalizeText(previousText).replace(/\s+/g, "").slice(-60);
    const newFlat  = normalizeText(newText).replace(/\s+/g, "");
    for (let len = Math.min(40, newFlat.length); len >= 3; len--) {
      if (prevFlat.endsWith(newFlat.slice(0, len))) return normalizeText(newText).slice(len);
    }
  }

  return normalizeText(newText);
}

function resetTranslationContext() {
  translatedContextWindow = []; recentOriginalFragments = [];
  if (ttsFlushTimer) { clearTimeout(ttsFlushTimer); ttsFlushTimer = null; }
  ttsBuffer = ""; ttsBufferLang = "";
  try { chrome.tts.stop(); } catch (e) {}
}

async function translateWithGoogle(text, targetLangCode) {
  const input = normalizeText(text);
  if (isSpacelessScript(input) ? input.length < 1 : input.length < 3) return "";

  try {
    const url = new URL("https://clients5.google.com/translate_a/t");
    url.searchParams.set("client", "dict-chrome-ex"); url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", targetLangCode); url.searchParams.set("q", input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) return "";
      const data = await response.json();
      let result = "";
      if (Array.isArray(data) && Array.isArray(data[0])) result = data.map(item => (Array.isArray(item) ? item[0] : "")).join("");
      else if (data?.sentences) result = data.sentences.map(s => s.trans || "").join("");
      return normalizeText(result);
    } finally { clearTimeout(timer); }
  } catch (e) {
      return "";
    }
}

const SAFETY_SETTINGS_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

function _isProModel(model) { return /pro/i.test(model); }

async function _geminiAttempt(prompt, model, apiKey, timeoutMs) {
  const isGemma = model.toLowerCase().includes("gemma");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = { contents: [{ parts: [{ text: prompt }] }] };

    if (model.match(/gemini-3(\.\d+)?.*pro/i)) body.generationConfig = { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } };
    else if (model.match(/gemini-3(\.\d+)?.*flash/i)) body.generationConfig = { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "minimal" } };
    else if (isGemma) body.generationConfig = { temperature: 0.1, thinkingConfig: { thinkingLevel: "MINIMAL" } };
    else body.generationConfig = { temperature: 0.1, maxOutputTokens: 1024 };

    if (!isGemma) body.safetySettings = SAFETY_SETTINGS_OFF;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || response.statusText || "Fetch error";
      console.error(`Gemini HTTP ${response.status} for model "${model}":`, errorMsg, errorData);
      throw new Error(`Gemini HTTP ${response.status}: ${errorMsg}`);
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought && typeof p.text === "string" && p.text.trim()) || parts[0];
    return normalizeText(textPart?.text || "");
  } finally { clearTimeout(timer); }
}

function _buildPrompt(input, langName, isCorrection, shownTail) {
  const strictRule =
    `You are a professional subtitle translator. You MUST output ONLY the translated text in ${langName}. ` +
    `NEVER output the original source language. If the input text appears highly repetitive or looping, translate it anyway as best as you can without repeating it endlessly. ` +
    `No explanations, no notes, no markdown, no introductory phrases. ` +
    `Do NOT add or invent content.`;

  if (isCorrection) {
    return `${strictRule}\nTask: Fix ONLY punctuation, spelling, and grammar in ${langName}. Do NOT change, replace or paraphrase any word. Every word in the input must appear in the output. If a word seems wrong or odd, keep it exactly as-is.\nInput: ${input}`;
  }

  const rawAnchor = shownTail || translatedContextWindow.join(" ");
  let anchor = "";
  if (rawAnchor) {
    if (SPACELESS_RE.test(rawAnchor)) anchor = rawAnchor.replace(/\s+/g, "").slice(-20);
    else anchor = rawAnchor.split(/\s+/).filter(Boolean).slice(-4).join(" ");
  }

  if (anchor) {
    return `${strictRule}\nTask: Translate the New Text to ${langName}.\nContext (previously translated end): "... ${anchor}"\nOutput ONLY the translation of the New Text. Do NOT translate or include the Context in your output.\nNew Text: ${input}`;
  }

  return `${strictRule}\nTask: Translate the text to ${langName}.\nInput: ${input}`;
}

async function translateWithGemini(originalText, targetLangCode, model, apiKey, sourceLangCode, shownTail) {
  const input = normalizeText(originalText);
  if (!apiKey || (isSpacelessScript(input) ? input.length < 1 : input.length < 3)) return "";

  let langName = targetLangCode;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    langName = displayNames.of(targetLangCode) || targetLangCode;
  } catch (e) {}

  const slBase = (sourceLangCode || "").toLowerCase().split('-')[0];
  const tlBase = (targetLangCode || "").toLowerCase().split('-')[0];
  const isCorrection = !!(slBase && slBase !== "auto" && slBase === tlBase);

  const prompt = _buildPrompt(input, langName, isCorrection, shownTail);
  const isPro = _isProModel(model);

  let translated = ""; let geminiError = ""; 

  if (isPro) {
    try { translated = await _geminiAttempt(prompt, model, apiKey, 8000); } catch (e) { geminiError = e.name === "AbortError" ? `${model}: timeout (8s)` : `${model}: ${e.message}`; }
  } else {
    try { translated = await _geminiAttempt(prompt, model, apiKey, 4000); } catch (e) { geminiError = e.name === "AbortError" ? `${model}: timeout (4s)` : `${model}: ${e.message}`; }
    if (!translated) {
      try { translated = await _geminiAttempt(prompt, model, apiKey, 4000); } catch (e) {
        if (!geminiError) geminiError = e.name === "AbortError" ? `${model}: timeout (4s)` : `${model}: ${e.message}`;
      }
    }
  }

  let usedFallback = false;
  if (!translated) {
    translated = await translateWithGoogle(input, targetLangCode);
    if (translated) usedFallback = true;
  }

  if (!translated) return { text: "", geminiError };
  if (shownTail && translated) {
    translated = trimTranslatedPrefixOverlap(shownTail, translated);
  }

  let contextEntry;
  if (shownTail) {
    if (isSpacelessScript(shownTail)) contextEntry = shownTail.replace(/\s+/g, "").slice(-40) + translated;
    else contextEntry = shownTail.split(/\s+/).filter(Boolean).slice(-20).join(" ") + " " + translated;
  } else {
    contextEntry = translated;
  }
  translatedContextWindow.push(contextEntry);
  if (translatedContextWindow.length > MAX_CONTEXT_SIZE) translatedContextWindow.shift();

  const text = usedFallback ? `\u207A ${translated}` : translated;
  return { text, geminiError: usedFallback ? geminiError : "" };
}

function speakTextImmediate(text, lang) {
  const clean = normalizeText(text);
  if (!clean) return;

  chrome.storage.local.get(["ttsSpeed"], (res) => {
    const rate = Number.parseFloat(res?.ttsSpeed || "1.0");
    const options = { rate: Number.isFinite(rate) ? rate : 1.0, pitch: 1.0, volume: 1.0, enqueue: true };
    if (lang && lang.trim() !== "" && lang.trim() !== "AUTO") options.lang = lang;
    try { chrome.tts.speak(clean, options); } catch (e) {}
  });
}

function flushTtsBuffer() {
  if (ttsFlushTimer) { clearTimeout(ttsFlushTimer); ttsFlushTimer = null; }
  const text = ttsBuffer.trim(); const lang = ttsBufferLang;
  ttsBuffer = ""; ttsBufferLang = "";
  if (text) speakTextImmediate(text, lang);
}

function speakText(text, lang) {
  const clean = normalizeText(text);
  if (!clean) return;

  const SENTENCE_END_RE_BG = /[.!?:\u2026\u3002\uFF01\uFF1F\u3001\u061F\u060C\u061B\u0964\u0965\u104A\u104B\u17D4\u1362\u0589]/;
  if (ttsBuffer && SENTENCE_END_RE_BG.test(ttsBuffer)) flushTtsBuffer();
  if (ttsBuffer && ttsBufferLang && lang && ttsBufferLang !== lang) flushTtsBuffer();

  if (!ttsBufferLang && lang) ttsBufferLang = lang;
  ttsBuffer = ttsBuffer ? ttsBuffer + " " + clean : clean;

  const wordCount = isSpacelessScript(ttsBuffer) ? ttsBuffer.replace(/\s+/g, "").length : ttsBuffer.split(/\s+/).filter(Boolean).length;
  const threshold = isSpacelessScript(ttsBuffer) ? TTS_BUFFER_MIN_CHARS : TTS_BUFFER_MIN_WORDS;

  if (wordCount >= threshold) flushTtsBuffer();
  else {
    if (ttsFlushTimer) clearTimeout(ttsFlushTimer);
    ttsFlushTimer = setTimeout(flushTtsBuffer, TTS_BUFFER_SILENCE_MS);
  }
}

function setCapturingState(isCapturing) {
  chrome.storage.local.set({ capturingState: { isCapturing: !!isCapturing }, isCapturing: !!isCapturing });
  safeSendRuntimeMessage({ action: "toggleCaptureButtons", isCapturing: !!isCapturing });
}

function notifyLanguage(detectedLanguage) {
  safeSendRuntimeMessage({ action: "updateSelectedLanguage", detectedLanguage: detectedLanguage || null });
}

function openOptionsTab() {
  return new Promise((resolve) => {
    chrome.tabs.create(
      { pinned: true, active: false, url: `chrome-extension://${chrome.runtime.id}/options.html` },
      (tab) => resolve(tab || null)
    );
  });
}

function openStandaloneWindow() {
  return new Promise((resolve) => {
    chrome.windows.create(
      { url: chrome.runtime.getURL("standalone.html"), type: "popup", width: 920, height: 360 },
      (win) => { const tabId = win?.tabs?.[0]?.id || null; resolve(tabId); }
    );
  });
}

async function stopCaptureInternal() {
  if (isStoppingCapture) return;
  isStoppingCapture = true;

  try { chrome.tts.stop(); } catch (e) {}

  try {
    const storageKeys = [ "optionTabId", "currentTabId", "standaloneTabId", "captureSourceTabId" ];
    const storage = await getStorage(storageKeys);

    const idsToStop = Array.from(new Set([ storage.captureSourceTabId, storage.currentTabId, storage.standaloneTabId, storage.optionTabId ].filter(Boolean)));
    await Promise.all(idsToStop.map((id) => sendMessageToTab(id, { type: "STOP" }).catch((err) => console.log(`Stop message failed for tab ${id}:`, err))));
    await delay(100);

    const closePromises = [];
    if (storage.standaloneTabId) closePromises.push(removeChromeTab(storage.standaloneTabId).catch(() => {}));
    if (storage.optionTabId) closePromises.push(removeChromeTab(storage.optionTabId).catch(() => {}));
    await Promise.all(closePromises);

    resetTranslationContext();
    await setStorage({ optionTabId: null, currentTabId: null, standaloneTabId: null, captureSourceTabId: null });
    setCapturingState(false);
  } catch (error) {
    console.error("stopCaptureInternal error:", error); setCapturingState(false);
  } finally { isStoppingCapture = false; }
}

function stopCapture() { void Promise.resolve().then(() => stopCaptureInternal()); }

async function startCaptureInternal(options) {
  if (isCaptureStarting) return;
  isCaptureStarting = true;

  try {
    const isSubTTSActive = await getStorageValue("isSubtitleTtsActive");
    if (isSubTTSActive) { await stopSubtitleTtsInternal(); await delay(250); }

    const prevSourceTabId = await getStorageValue("captureSourceTabId");
    if (prevSourceTabId) { await sendMessageToTab(prevSourceTabId, { type: "STOP" }); }

    const currentState = await getStorageValue("capturingState");
    if (currentState?.isCapturing) { await stopCaptureInternal(); await delay(250); }

    const sourceTab = await getTab(options.tabId);
    if (!sourceTab) { setCapturingState(false); return; }

    const oldOptionTabId = await getStorageValue("optionTabId");
    if (oldOptionTabId) { await removeChromeTab(oldOptionTabId); await setStorage({ optionTabId: null }); }

    const oldStandaloneTabId = await getStorageValue("standaloneTabId");
    if (oldStandaloneTabId) { await removeChromeTab(oldStandaloneTabId); await setStorage({ standaloneTabId: null }); }

    if (!options.useStandalone) {
      const injected = await executeScriptInTab(sourceTab.id, "content.js");
      if (!injected) throw new Error("Failed to inject content.js");
      await delay(120);
      await sendMessageToTab(sourceTab.id, { type: "resetSession", isSubtitleMode: false, isStandalone: false });
      await setStorage({ currentTabId: sourceTab.id, captureSourceTabId: sourceTab.id });
    } else {
      try {
        const injected = await executeScriptInTab(sourceTab.id, "content.js");
        if (injected) {
          await delay(120);
          await sendMessageToTab(sourceTab.id, { type: "resetSession", isSubtitleMode: false, isStandalone: true });
        }
      } catch (e) { console.warn("Could not inject volume controller on protected source tab. Proceeding with Standalone Mode anyway.", e); }
      await setStorage({ captureSourceTabId: sourceTab.id });
    }

    const optionTab = await openOptionsTab();
    if (!optionTab?.id) throw new Error("Failed to open options.html");

    await setStorage({ optionTabId: optionTab.id });
    await delay(300);

    const { selectedLanguage, selectedTask, selectedModelSize } = await getStorage(["selectedLanguage", "selectedTask", "selectedModelSize"]);

    const startMessage = {
      type: "start_capture",
      data: {
        currentTabId: sourceTab.id, host: options.host || "localhost", port: options.port || "9090",
        multilingual: !!options.useMultilingual, language: selectedLanguage || null,
        task: selectedTask || "transcribe", modelSize: selectedModelSize || "small",
        useVad: !!options.useVad, useStandalone: !!options.useStandalone
      }
    };

    const started = await sendMessageToTab(optionTab.id, startMessage);
    if (!started || started.success === false) throw new Error("Failed to start capture in options.js");

    if (options.useStandalone) {
      setCapturingState(true);
      const standaloneTabId = await openStandaloneWindow();
      if (!standaloneTabId) throw new Error("Failed to open standalone window");
      await setStorage({ standaloneTabId, currentTabId: standaloneTabId });
      await delay(500);
      await sendMessageToTab(standaloneTabId, { type: "resetSession", isSubtitleMode: false });
      await sendMessageToTab(optionTab.id, { type: "update_target", data: { currentTabId: standaloneTabId } });
    } else {
      setCapturingState(true);
    }
  } catch (error) {
    console.error("startCaptureInternal error:", error); await stopCaptureInternal(); setCapturingState(false);
  } finally { isCaptureStarting = false; }
}

function startCapture(options) { void Promise.resolve().then(() => startCaptureInternal(options)); }

function setSubtitleTtsState(isActive) {
  chrome.action.setBadgeText({ text: isActive ? "TTS" : "" });
  if (!isActive) subtitleTabId = null;
  chrome.storage.local.set({ isSubtitleTtsActive: !!isActive }).catch(()=>{});
  safeSendRuntimeMessage({ action: "subtitleTtsStateChanged", isActive: !!isActive });
}

async function startSubtitleTtsInternal(tabId) {
  const currentState = await getStorageValue("capturingState");
  if (currentState?.isCapturing) { await stopCaptureInternal(); await delay(250); }

  resetTranslationContext();
  subtitleTabId = tabId;
  setSubtitleTtsState(true);

  const settings = await getStorage(["targetLanguage", "ttsSpeed", "subtitlePlaybackControl", "subtitleSlowdownRate", "useStandalone", "hideNativeSubtitles", "subtitleVideoVolume", "enableTts", "enableGeminiTranslation", "sttsSelectedLanguage", "subtitleTtsProfile"]);

  if (!settings.useStandalone) {
    const contentInjected = await executeScriptInTab(tabId, "content.js");
    if (!contentInjected) console.warn("Failed to inject content.js for Subtitle TTS overlay.");
    else { await setStorage({ currentTabId: tabId }); await delay(50); await sendMessageToTab(tabId, { type: "resetSession", isSubtitleMode: true }); }
  } else {
    await executeScriptInTab(tabId, "content.js");
    await delay(50);
    await sendMessageToTab(tabId, { type: "resetSession", isSubtitleMode: true, isStandalone: true });
    const standaloneTabId = await openStandaloneWindow();
    if (standaloneTabId) {
      await setStorage({ standaloneTabId, currentTabId: standaloneTabId });
      await delay(500);
      await sendMessageToTab(standaloneTabId, { type: "resetSession", isSubtitleMode: true });
    }
  }

  const inj = await injectSubtitleTts(tabId);
  if (!inj.ok) { setSubtitleTtsState(false); return { success: false, error: "Failed to inject subtitle_tts.js. Check that the page allows extensions." }; }

  await delay(120);

  // When injected across frames, select the target frame hosting the primary video.
  // Players are sometimes created a moment after the page settles, so probe a few times.
  let targetFrameId = null;
  if (inj.allFrames) {
    let found = await probeVideoFrames(tabId);
    for (let attempt = 0; attempt < 6 && !found.length; attempt++) {
      await delay(500);
      found = await probeVideoFrames(tabId);
    }
    if (found.length) targetFrameId = found.sort((a, b) => b.score - a.score)[0].frameId;
  }

  const initMsg = {
    type: "SUBTITLE_TTS_INIT",
    settings: {
      enableGeminiTranslation: !!settings.enableGeminiTranslation, enableTts: !!settings.enableTts,
      targetLanguage: settings.targetLanguage || "en", sttsSelectedLanguage: settings.sttsSelectedLanguage || "",
      ttsSpeed: parseFloat(settings.ttsSpeed) || 1.0, playbackControl: settings.subtitlePlaybackControl || "pause",
      slowdownRate: parseFloat(settings.subtitleSlowdownRate) || 0.8, hideNativeSubtitles: settings.hideNativeSubtitles !== false,
      videoVolume: parseFloat(settings.subtitleVideoVolume || "1.0"),
      subtitleTtsProfile: settings.subtitleTtsProfile || "balanced",
      ownDocOnly: targetFrameId !== null
    }
  };

  const response = targetFrameId !== null
    ? await sendMessageToTab(tabId, initMsg, { frameId: targetFrameId })
    : await sendMessageToTab(tabId, initMsg);

  if (!response || response.success === false) {
    setSubtitleTtsState(false);
    const errorCode = response?.error || "no_track";
    if (errorCode === "no_video") {
      await sendMessageToTab(tabId, { type: "STOP" }).catch(()=>{});
      return { success: false, error: "No video found on this page." };
    }
  }

  await setStorage({ subtitleSourceTabId: tabId });
  if (inj.allFrames && targetFrameId !== null && response && response.success !== false) startFrameFollow(tabId, targetFrameId, initMsg);
  return { success: true };
}

async function stopSubtitleTtsInternal() {
  stopFrameFollow();
  resetTranslationContext();
  const tabId = subtitleTabId || await getStorageValue("subtitleSourceTabId");
  try { chrome.tts.stop(); } catch (e) {}

  if (tabId) {
    await sendMessageToTab(tabId, { type: "STOP_SUBTITLE_TTS" }).catch(()=>{});
    await sendMessageToTab(tabId, { type: "STOP" }).catch(()=>{});
  }

  const standaloneTabId = await getStorageValue("standaloneTabId");
  if (standaloneTabId) {
    await sendMessageToTab(standaloneTabId, { type: "STOP" }).catch(()=>{});
    await removeChromeTab(standaloneTabId).catch(()=>{});
    await setStorage({ standaloneTabId: null });
  }

  subtitleTabId = null;
  setSubtitleTtsState(false);
  await setStorage({ subtitleSourceTabId: null, isSubtitleTtsActive: false });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.action === "detectTextLanguage") {
      try {
        chrome.i18n.detectLanguage(message.text, (result) => {
          let lang = "";
          if (result && result.isReliable && result.languages && result.languages.length > 0) lang = result.languages[0].language;
          sendResponse({ language: lang });
        });
      } catch (e) { sendResponse({ language: "" }); }
      return true;
    }

    if (message.action === "clearSubtitleHistory") {
      resetTranslationContext();
      getStorage(["currentTabId", "standaloneTabId"]).then(res => {
        if (res.currentTabId) sendMessageToTab(res.currentTabId, message);
        if (res.standaloneTabId) sendMessageToTab(res.standaloneTabId, message);
      });
      sendResponse({ success: true });
      return true;
    }

    if (message.action === "whisperSeeked") {
      resetTranslationContext();
      getStorage(["currentTabId", "standaloneTabId"]).then(res => {
        if (res.currentTabId) sendMessageToTab(res.currentTabId, { type: "clearWhisperBuffers" });
        if (res.standaloneTabId) sendMessageToTab(res.standaloneTabId, { type: "clearWhisperBuffers" });
      });
      sendResponse({ success: true });
      return true;
    }

    if (message.action === "speakTranslatedText") {
      getStorage(["enableTts"]).then((res) => {
        if (!res.enableTts) { sendResponse({ success: true }); return; }
        speakText(message.text, message.lang);
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.action === "startCapture") { startCapture(message); sendResponse({ success: true }); return false; }
    if (message.type === "STOP") { stopCapture(); stopSubtitleTtsInternal().catch(()=>{}); sendResponse({ success: true }); return false; }
    if (message.action === "stopCapture") { stopCapture(); sendResponse({ success: true }); return false; }
    if (message.action === "toggleCaptureButtons") {
      const isCapturing = typeof message.isCapturing === "boolean" ? message.isCapturing : typeof message.data === "boolean" ? message.data : false;
      setCapturingState(isCapturing); sendResponse({ success: true }); return false;
    }
    if (message.action === "updateSelectedLanguage") {
      const detectedLanguage = message.detectedLanguage || null;
      chrome.storage.local.set({ selectedLanguage: detectedLanguage }); notifyLanguage(detectedLanguage);
      sendResponse({ success: true }); return false;
    }
    if (message.action === "resetTranslationContext") { resetTranslationContext(); sendResponse({ success: true }); return false; }
    if (message.action === "stopTts") {
      activeSubtitleUtteranceId++;
      if (message.isSeek) { isSeekInterrupt = true; setTimeout(() => { isSeekInterrupt = false; }, 1000); }
      if (ttsFlushTimer) { clearTimeout(ttsFlushTimer); ttsFlushTimer = null; }
      ttsBuffer = ""; ttsBufferLang = "";
      try { chrome.tts.stop(); } catch (e) {}
      sendResponse({ success: true }); return false;
    }
    if (message.action === "pageUnloading") { sendResponse({ success: true }); return false; }
    
    if (message.type === "subtitle_display") {
      getStorage(["currentTabId", "standaloneTabId"]).then(res => {
        const dest = res.currentTabId || sender.tab?.id || subtitleTabId;
        if (dest) sendMessageToTab(dest, message).catch(() => {});
        if (res.standaloneTabId && res.standaloneTabId !== dest) {
          sendMessageToTab(res.standaloneTabId, message).catch(() => {});
        }
      });
      sendResponse({ success: true }); return true;
    }
    
    if (message.action === "speakOriginalText") {
      getStorage(["enableTts", "selectedTask", "selectedLanguage"]).then((res) => {
        if (!res.enableTts) { sendResponse({ success: true }); return; }
        let ttsLang = "";
        if (res.selectedTask === "translate") ttsLang = "en"; 
        else if (res.selectedLanguage && res.selectedLanguage !== "AUTO") ttsLang = res.selectedLanguage;
        speakText(message.text, ttsLang); sendResponse({ success: true });
      });
      return true;
    }
    
    if (message.action === "subtitleSpeak") {
      const text = normalizeText(message.text); const lang = message.lang || "";
      const rate = Number.parseFloat(message.ttsSpeed) || 1.0; const fromTabId = sender.tab?.id || subtitleTabId;
      const utteranceId = message.utteranceId; const fromFrameId = sender.frameId;
      activeSubtitleUtteranceId++;
      const currentUtteranceId = activeSubtitleUtteranceId;

      if (!text) { if (fromTabId) sendTtsDone(fromTabId, fromFrameId, utteranceId); sendResponse({ success: true }); return false; }
      try { chrome.tts.stop(); } catch (e) {}

      const options = {
        rate: Number.isFinite(rate) ? Math.max(0.1, Math.min(10, rate)) : 1.0, pitch: 1.0, volume: 1.0, enqueue: false,
        onEvent: (event) => {
          if (currentUtteranceId !== activeSubtitleUtteranceId) return;
          if (event.type === "end") {
            if (fromTabId) sendTtsDone(fromTabId, fromFrameId, utteranceId);
          }
        }
      };

      const executeSpeak = () => {
        try { chrome.tts.speak(text, options); } catch (e) {
          console.error("subtitleSpeak TTS error:", e);
          if (fromTabId && currentUtteranceId === activeSubtitleUtteranceId) sendTtsDone(fromTabId, fromFrameId, utteranceId);
        }
      };

      if (lang && lang.trim()) { options.lang = lang; executeSpeak(); }
      else {
        getStorage(["selectedLanguage", "selectedTask"]).then(res => {
          let fallbackLang = "";
          if (res.selectedTask === "translate") fallbackLang = "en";
          else if (res.selectedLanguage && res.selectedLanguage !== "AUTO") fallbackLang = res.selectedLanguage;
          if (fallbackLang) { options.lang = fallbackLang; executeSpeak(); }
          else {
            chrome.i18n.detectLanguage(text, (result) => {
              if (result && result.isReliable && result.languages && result.languages.length > 0) options.lang = result.languages[0].language;
              executeSpeak();
            });
          }
        });
      }
      sendResponse({ success: true }); return true;
    }
    
    if (message.action === "fetchSubtitleFile") {
      (async () => {
        try {
          const url = String(message.url || "");
          let host = "";
          try { host = new URL(url).hostname; } catch (e) {}
          if (!/^https?:\/\//i.test(url) || isPrivateHost(host)) { sendResponse({ ok: false, error: "blocked" }); return; }
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 10000);
          const r = await fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
          clearTimeout(tm);
          if (!r.ok) { sendResponse({ ok: false, status: r.status }); return; }
          const text = await r.text();
          if (text.length > 4000000) { sendResponse({ ok: false, error: "too_large" }); return; }
          sendResponse({ ok: true, text });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      })();
      return true;
    }

    if (message.action === "startSubtitleTts") {
      const tabId = message.tabId;
      if (!tabId) { sendResponse({ success: false, error: "No tab ID provided" }); return false; }
      startSubtitleTtsInternal(tabId).then((result) => sendResponse(result)).catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.action === "stopSubtitleTts") {
      stopSubtitleTtsInternal().then(() => sendResponse({ success: true })).catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.action === "processTranslation") {
      getStorage(["geminiApiKey", "geminiModel", "targetLanguage", "enableTts", "selectedLanguage"])
        .then(async (res) => {
          const targetLang = res.targetLanguage || "es"; const apiKey = res.geminiApiKey || "";
          const model = res.geminiModel || "gemini-3.1-flash-lite"; const sourceLang = message.sourceLang !== undefined ? message.sourceLang : (res.selectedLanguage || "");
          const shownTail = normalizeText(message.shownTail || ""); const skipTts = !!message.skipTts;
          let translated = "";

          if (model === "google-translate") {
            translated = await translateWithGoogle(message.text, targetLang);
          } else if (!apiKey) {
            translated = await translateWithGoogle(message.text, targetLang);
            if (translated) translated = "\u207A " + translated; 
          } else {
            try {
              const result = await translateWithGemini(message.text, targetLang, model, apiKey, sourceLang, shownTail);
              translated = result?.text ?? result ?? "";
              const geminiError = result?.geminiError || "";
              if (!skipTts && res.enableTts && translated) { const ttsText = translated.replace(/^\u207A\s*/, ""); speakText(ttsText, targetLang); }
              if (geminiError) { sendResponse({ success: true, data: translated, geminiError }); }
              else sendResponse({ success: true, data: translated });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
            return;
          }

          if (!skipTts && res.enableTts && translated) { const ttsText = translated.replace(/^\u207A\s*/, ""); speakText(ttsText, targetLang); }
          sendResponse({ success: true, data: translated || "" });
        }).catch((err) => { sendResponse({ success: false, error: err.message }); });
      return true;
    }
    sendResponse({ success: false, error: "Unknown action" }); return false;
  } catch (e) { console.error("Runtime message error:", e); sendResponse({ success: false, error: e.message }); return false; }
});

// Resumes a Subtitle TTS start that was interrupted by a host permission prompt
// (the prompt closes the popup before it can continue on its own).
const PENDING_START_MAX_AGE_MS = 120000;
chrome.permissions.onAdded.addListener(async () => {
  try {
    const { pendingSubtitleStart, isSubtitleTtsActive } = await getStorage(["pendingSubtitleStart", "isSubtitleTtsActive"]);
    if (!pendingSubtitleStart) return;
    await chrome.storage.local.remove("pendingSubtitleStart");
    if (isSubtitleTtsActive || Date.now() - pendingSubtitleStart.ts > PENDING_START_MAX_AGE_MS) return;
    if (!(await getTab(pendingSubtitleStart.tabId))) return;
    await startSubtitleTtsInternal(pendingSubtitleStart.tabId);
    // Reopen the popup so the user sees the active state (not available in every Chrome version)
    try { await chrome.action.openPopup(); } catch (e) {}
  } catch (e) { console.warn("Pending Subtitle TTS start failed:", e); }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ 
    [STARTUP_FLAG_KEY]: true,
    capturingState: { isCapturing: false },
    isCapturing: false,
    isSubtitleTtsActive: false
  });
  setTimeout(() => { chrome.storage.local.remove(STARTUP_FLAG_KEY); }, 10000);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(
    ["optionTabId", "currentTabId", "standaloneTabId", "captureSourceTabId", "capturingState", "isSubtitleTtsActive", "subtitleSourceTabId"],
    (result) => {
      const isSubtitleTab = tabId === result.standaloneTabId || tabId === result.subtitleSourceTabId || tabId === subtitleTabId;
      if ((result?.isSubtitleTtsActive || subtitleTabId) && isSubtitleTab) { stopSubtitleTtsInternal().catch(()=>{}); return; }
      if (!result?.capturingState?.isCapturing) return;
      const tracked = [ result.optionTabId, result.currentTabId, result.standaloneTabId, result.captureSourceTabId ].filter(Boolean);
      if (tracked.includes(tabId)) { try { chrome.tts.stop(); } catch (e) {} stopCapture(); }
    }
  );
});

// Single-page sites change the address without replacing the document. On those sites a
// navigation keeps the running Subtitle TTS session as long as the page's script is still alive.
const KEEP_ALIVE_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch)$/i;
const subtitleNavPending = new Set();

function isKeepAliveUrl(url) {
  try { return KEEP_ALIVE_HOST_RE.test(new URL(url).hostname); } catch (e) { return false; }
}

function isSubtitleScriptAlive(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__subtitleTtsApi }, (results) => {
        if (chrome.runtime.lastError || !Array.isArray(results) || !results[0]) { resolve(false); return; }
        resolve(!!results[0].result);
      });
    } catch (e) { resolve(false); }
  });
}

async function handleSubtitleTabNavigation(tabId, status) {
  const stopIfActive = async () => {
    const st = await getStorage(["isSubtitleTtsActive", "subtitleSourceTabId"]);
    if (st.isSubtitleTtsActive && st.subtitleSourceTabId === tabId) await stopSubtitleTtsInternal();
  };
  if (status === "loading") {
    const tab = await getTab(tabId);
    if (!tab || !isKeepAliveUrl(tab.url)) { await stopIfActive(); return; }
    subtitleNavPending.add(tabId);
    await delay(1500);
    if (!(await isSubtitleScriptAlive(tabId))) { subtitleNavPending.delete(tabId); await stopIfActive(); }
    return;
  }
  // Load finished: stop the session if the document was replaced in the meantime.
  if (subtitleNavPending.delete(tabId) && !(await isSubtitleScriptAlive(tabId))) await stopIfActive();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") return;
  chrome.storage.local.get(
    ["captureSourceTabId", "standaloneTabId", "capturingState", "subtitleSourceTabId", "isSubtitleTtsActive"],
    (result) => {
      if (result?.isSubtitleTtsActive && tabId === result.subtitleSourceTabId) {
        handleSubtitleTabNavigation(tabId, changeInfo.status).catch(()=>{});
        return;
      }
      if (changeInfo.status !== "loading") return;
      if (!result?.capturingState?.isCapturing) return;
      if (result.standaloneTabId) return;
      if (tabId === result.captureSourceTabId) { try { chrome.tts.stop(); } catch (e) {} stopCapture(); }
    }
  );
});

self.addEventListener("unhandledrejection", (event) => {
  const message = event?.reason?.message || "";
  if (message.includes("Could not establish connection")) { event.preventDefault(); return true; }
});
