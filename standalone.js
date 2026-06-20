/*
 * standalone.js — part of Audio Transcription
 * Copyright (C) 2026 Antonio Ruiz
 *
 * This file is part of Audio Transcription.
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
 */

(function () {
  const TEXT_BLOCK_STYLE =
    "padding:0 16px 10px 16px;display:block;white-space:pre-wrap;word-break:break-word;";

  const MANIFEST_VERSION = chrome.runtime.getManifest?.()?.version || "";

  const transcriptionOriginalEl = document.getElementById("transcription-original");
  const transcriptionTranslatedEl = document.getElementById("transcription-translated");
  const transcriptionHeaderEl = document.getElementById("transcription-header");
  const statusLineEl = document.getElementById("status-line");
  const dividerEl = document.getElementById("transcription-divider");
  const contentWrapper = document.getElementById("transcription-content");
  const btnDecrease = document.getElementById("btn-decrease");
  const btnIncrease = document.getElementById("btn-increase");
  const btnCopy = document.getElementById("btn-copy");

  if (transcriptionHeaderEl) transcriptionHeaderEl.style.display = "none";

  let segments = [];
  let previousSegments = [];
  let historyChunks = [];
  let historyChunksRaw = [];
  let translatedChunks = [];
  let pendingStableText = "";
  let windowStartTime = Date.now();
  let currentFormatting = "advanced";
  let currentDisplayMode = "both";
  let currentFontSize = 20;
  let lastReceivedTime = Date.now();
  let silenceFlushTimer = null;
  let statusClearTimer = null;
  let isDraggingDivider = false;
  let translationQueue = [];
  let isTranslatingLocal = false;

  let enableGeminiTranslation = false;
  let enableTts = false;
  let dedupTail = [];
  let hideLiveText = false;
  let isSubtitleMode = false;
  let currentTrackLang = "";
  let subtitleOriginalHistory = [];
  let subtitleTranslatedHistory = [];

  const PROFILES = {
    accurate: {
      stableWordCount: 15, stableElapsed: 4000, stableSegments: 7,
      safeCommitKeep: 3, safeCommitMinSeg: 5, safeCommitElapsed: 5000,
      fallbackElapsed: 6000, silenceFlushMs: 2000, silenceCheckMs: 1000,
      translationMinWords: 20, translationSentenceWords: 14, translationSilenceMs: 2500,
      alignmentSamples: 8, similarityThreshold: 0.90
    },
    balanced: {
      stableWordCount: 10, stableElapsed: 2500, stableSegments: 5,
      safeCommitKeep: 2, safeCommitMinSeg: 4, safeCommitElapsed: 3500,
      fallbackElapsed: 4000, silenceFlushMs: 1200, silenceCheckMs: 800,
      translationMinWords: 16, translationSentenceWords: 10, translationSilenceMs: 1500,
      alignmentSamples: 6, similarityThreshold: 0.87
    },
    lowlag: {
      stableWordCount: 6, stableElapsed: 1500, stableSegments: 3,
      safeCommitKeep: 1, safeCommitMinSeg: 2, safeCommitElapsed: 1800,
      fallbackElapsed: 2500, silenceFlushMs: 1000, silenceCheckMs: 500,
      translationMinWords: 10, translationSentenceWords: 6, translationSilenceMs: 1000,
      alignmentSamples: 5, similarityThreshold: 0.88
    }
  };
  
  let activeProfile = PROFILES.balanced;

  function getProfile(name) { return PROFILES[name] || PROFILES.balanced; }
  function normalizeText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function stripPunctuation(text) { return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim(); }
  function splitWords(text) { return stripPunctuation(text).split(" ").filter(Boolean); }
  function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }

  const SPACELESS_RE = /[\u3040-\u9FFF\uF900-\uFAFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF]/;
  const SENTENCE_END_CHARS = ".!?\u2026\u3002\uFF01\uFF1F\u3001\u061F\u060C\u061B\u0964\u0965\u104A\u104B\u17D4\u1362\u0589";
  const SENTENCE_END_RE = new RegExp("[" + SENTENCE_END_CHARS + "]");

  function isSpacelessScript(text) { return SPACELESS_RE.test(text); }

  function countWords(text) {
    const t = normalizeText(text);
    if (!t) return 0;
    const spaceWords = t.split(/\s+/).filter(Boolean).length;
    const spacelessChars = (t.match(SPACELESS_RE) || []).length;
    return spacelessChars > spaceWords ? spacelessChars : spaceWords;
  }

  function calculateTextSimilarity(a, b) {
    const isSpaceless = isSpacelessScript(a) || isSpacelessScript(b);
    if (isSpaceless) {
      const cleanA = a.replace(/\s+/g, "");
      const cleanB = b.replace(/\s+/g, "");
      if (!cleanA.length || !cleanB.length) return 0;
      const setA = new Set(cleanA);
      const setB = new Set(cleanB);
      let intersection = 0;
      for (const char of setB) { if (setA.has(char)) intersection++; }
      return intersection / Math.max(setA.size, setB.size);
    }
    const wa = splitWords(a);
    const wb = splitWords(b);
    if (!wa.length || !wb.length) return 0;
    const setA = new Set(wa);
    let matches = 0;
    for (const word of wb) { if (setA.has(word)) matches++; }
    return matches / Math.max(wa.length, wb.length);
  }

  function calculateBigramContainment(baseText, newText) {
    const baseWords = splitWords(baseText);
    const newWords = splitWords(newText);
    if (baseWords.length < 2 || newWords.length < 2) return 0;
    
    const baseBigrams = new Set();
    for (let i = 0; i < baseWords.length - 1; i++) {
      baseBigrams.add(baseWords[i] + " " + baseWords[i + 1]);
    }
    
    let matches = 0;
    const newBigramsCount = newWords.length - 1;
    for (let i = 0; i < newWords.length - 1; i++) {
      const bigram = newWords[i] + " " + newWords[i + 1];
      if (baseBigrams.has(bigram)) matches++;
    }
    
    return matches / newBigramsCount;
  }

  function isFuzzyMatch(textA, textB) {
    const a = stripPunctuation(textA);
    const b = stripPunctuation(textB);
    if (a === b) return true;
    const wa = a.split(" ").filter(Boolean);
    const wb = b.split(" ").filter(Boolean);
    if (wa.length >= 4 && wb.length >= 4) {
       if (calculateTextSimilarity(a, b) >= 0.75) return true;
    }
    return false;
  }

  function trimPrefixOverlap(baseText, candidateText, maxWords = 80, minWords = 3) {
    const isSpaceless = isSpacelessScript(baseText) || isSpacelessScript(candidateText);
    if (isSpaceless) {
      const cleanBase = baseText.replace(/\s+/g, "");
      const cleanCand = candidateText.replace(/\s+/g, "");
      const maxChars = Math.min(100, cleanBase.length, cleanCand.length);
      for (let size = maxChars; size >= 2; size--) {
        const suffix = cleanBase.slice(-size);
        const prefix = cleanCand.slice(0, size);
        if (suffix === prefix) {
          let charsMatched = 0; 
          let candIdx = 0;
          while (candIdx < candidateText.length && charsMatched < size) {
            if (!/\s/.test(candidateText[candIdx])) charsMatched++;
            candIdx++;
          }
          return normalizeText(candidateText.slice(candIdx));
        }
      }
      for (let size = maxChars; size >= 4; size--) {
        const suffix = cleanBase.slice(-size);
        const idx = cleanCand.indexOf(suffix);
        if (idx !== -1) {
          let charsMatched = 0; 
          let candIdx = 0;
          const targetCharCount = idx + size;
          while (candIdx < candidateText.length && charsMatched < targetCharCount) {
            if (!/\s/.test(candidateText[candIdx])) charsMatched++;
            candIdx++;
          }
          return normalizeText(candidateText.slice(candIdx));
        }
      }
      return normalizeText(candidateText);
    }

    const baseWords = splitWords(baseText);
    const rawCandidateWords = normalizeText(candidateText).split(/\s+/).filter(Boolean);
    const candidateWords = splitWords(candidateText);
    const max = Math.min(maxWords, baseWords.length, candidateWords.length);

    for (let size = max; size >= minWords; size--) {
      let errors = 0;
      const maxErrors = size >= 8 ? 2 : size >= 4 ? 1 : 0;
      for (let i = 0; i < size; i++) {
        if (baseWords[baseWords.length - size + i] !== candidateWords[i]) { 
          errors++; 
          if (errors > maxErrors) break; 
        }
      }
      if (errors <= maxErrors) return rawCandidateWords.slice(size).join(" ").trim();
    }

    const minAnywhere = Math.max(4, minWords);
    for (let size = max; size >= minAnywhere; size--) {
      const suffix = baseWords.slice(baseWords.length - size);
      let matchIdx = -1;
      const maxErrors = size >= 8 ? 2 : size >= 4 ? 1 : 0;
      for (let j = 0; j <= candidateWords.length - size; j++) {
        let errors = 0;
        for (let k = 0; k < size; k++) {
          if (suffix[k] !== candidateWords[j + k]) {
            errors++;
            if (errors > maxErrors) break;
          }
        }
        if (errors <= maxErrors) { matchIdx = j; break; }
      }
      if (matchIdx !== -1) {
        return rawCandidateWords.slice(matchIdx + size).join(" ").trim();
      }
    }
    return normalizeText(candidateText);
  }

  function trimPrefixOverlapRaw(baseText, rawCandidateText, maxWords = 80, minWords = 3) {
    const isSpaceless = isSpacelessScript(baseText) || isSpacelessScript(rawCandidateText);
    if (isSpaceless) {
      const cleanBase = baseText.replace(/\s+/g, "");
      const cleanCand = rawCandidateText.replace(/\s+/g, "");
      const maxChars = Math.min(100, cleanBase.length, cleanCand.length);
      for (let size = maxChars; size >= 2; size--) {
        const suffix = cleanBase.slice(-size);
        const prefix = cleanCand.slice(0, size);
        if (suffix === prefix) {
          let charsMatched = 0; 
          let candIdx = 0;
          while (candIdx < rawCandidateText.length && charsMatched < size) {
            if (!/\s/.test(rawCandidateText[candIdx])) charsMatched++;
            candIdx++;
          }
          return rawCandidateText.slice(candIdx).replace(/^[ \t\r\n]+/, "");
        }
      }
      for (let size = maxChars; size >= 4; size--) {
        const suffix = cleanBase.slice(-size);
        const idx = cleanCand.indexOf(suffix);
        if (idx !== -1) {
          let charsMatched = 0; 
          let candIdx = 0;
          const targetCharCount = idx + size;
          while (candIdx < rawCandidateText.length && charsMatched < targetCharCount) {
            if (!/\s/.test(rawCandidateText[candIdx])) charsMatched++;
            candIdx++;
          }
          return rawCandidateText.slice(candIdx).replace(/^[ \t\r\n]+/, "");
        }
      }
      return rawCandidateText;
    }

    const baseWords = splitWords(baseText);
    const candidateWords = splitWords(rawCandidateText);
    const max = Math.min(maxWords, baseWords.length, candidateWords.length);
    
    for (let size = max; size >= minWords; size--) {
      let errors = 0;
      const maxErrors = size >= 8 ? 2 : size >= 4 ? 1 : 0;
      for (let i = 0; i < size; i++) {
        if (baseWords[baseWords.length - size + i] !== candidateWords[i]) { 
          errors++; 
          if (errors > maxErrors) break; 
        }
      }
      if (errors <= maxErrors) {
        let matchCount = 0; 
        let removeUpTo = 0;
        const wordRegex = /\S+/g; 
        let m;
        while ((m = wordRegex.exec(rawCandidateText)) !== null) {
          matchCount++;
          if (matchCount === size) { removeUpTo = wordRegex.lastIndex; break; }
        }
        return rawCandidateText.slice(removeUpTo).replace(/^[ \t\r\n]+/, "");
      }
    }

    const minAnywhere = Math.max(4, minWords);
    for (let size = max; size >= minAnywhere; size--) {
      const suffix = baseWords.slice(baseWords.length - size);
      let matchIdx = -1;
      const maxErrors = size >= 8 ? 2 : size >= 4 ? 1 : 0;
      for (let j = 0; j <= candidateWords.length - size; j++) {
        let errors = 0;
        for (let k = 0; k < size; k++) {
          if (suffix[k] !== candidateWords[j + k]) {
            errors++;
            if (errors > maxErrors) break;
          }
        }
        if (errors <= maxErrors) { matchIdx = j; break; }
      }
      if (matchIdx !== -1) {
        let matchCount = 0; 
        let removeUpTo = 0;
        const targetWords = matchIdx + size;
        const wordRegex = /\S+/g; 
        let m;
        while ((m = wordRegex.exec(rawCandidateText)) !== null) {
          matchCount++;
          if (matchCount === targetWords) { removeUpTo = wordRegex.lastIndex; break; }
        }
        return rawCandidateText.slice(removeUpTo).replace(/^[ \t\r\n]+/, "");
      }
    }
    return rawCandidateText;
  }

  function removeInternalRepetitions(text, minMatchWords = 6) {
    const isSpaceless = isSpacelessScript(text);
    if (isSpaceless) {
      const clean = text.replace(/\s+/g, "");
      const minMatchChars = Math.max(2, Math.floor(minMatchWords / 2));
      if (clean.length < minMatchChars * 2) return text;
      for (let i = minMatchChars; i < clean.length; i++) {
        const maxLen = Math.min(25, clean.length - i);
        for (let len = maxLen; len >= minMatchChars; len--) {
          for (let j = 0; j <= i - len; j++) {
            let match = true;
            for (let k = 0; k < len; k++) {
              if (clean[j + k] !== clean[i + k]) { match = false; break; }
            }
            if (match) return clean.slice(0, i) + clean.slice(i + len);
          }
        }
      }
      return text;
    }
    const words = normalizeText(text).split(/\s+/).filter(Boolean);
    if (words.length < minMatchWords * 2) return text;
    const low = words.map(w => stripPunctuation(w));
    for (let i = minMatchWords; i < words.length; i++) {
      const maxLen = Math.min(25, words.length - i);
      for (let len = maxLen; len >= minMatchWords; len--) {
        for (let j = 0; j <= i - len; j++) {
          let match = true;
          for (let k = 0; k < len; k++) {
            if (low[j + k] !== low[i + k]) { match = false; break; }
          }
          if (match) return normalizeText(words.slice(0, i).join(" ") + " " + words.slice(i + len).join(" "));
        }
      }
    }
    return text;
  }

  function formatText(text, formatting) {
    if (!text) return "";
    const clean = normalizeText(text);
    if (!clean) return "";

    if (formatting === "none") {
      if (clean.includes("\n")) return clean;
      return clean.replace(/([.!?\u2026\u3002\uFF01\uFF1F\u061F])\s+/g, "$1\n");
    }

    let flat = clean.replace(/\n+/g, " ");
    if (formatting === "join") return flat;

    const getDeterministicLimit = (strText) => {
      let hash = 0; 
      const s = String(strText || "");
      for (let idx = 0; idx < s.length; idx++) {
        hash = (hash << 5) - hash + s.charCodeAt(idx); 
        hash |= 0;
      }
      return 3 + (Math.abs(hash) % 3);
    };

    const rawParagraphs = flat.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const processedParagraphs = [];
    let currentParagraphWords = [];
    let currentParagraphPeriods = 0;
    let randomPeriodLimit = 4;
    
    for (let pIdx = 0; pIdx < rawParagraphs.length; pIdx++) {
      const paragraphText = rawParagraphs[pIdx];
      const sentenceBoundaryRegex = /(?<!\b\p{L})(?<!\b(?:EE|UU|Sr|Sra|Dr|Dra|Mr|Mrs|Ms|Prof|St|Mt|etc|vs|cf|ie|eg|al|Ud|Vd|vd|ud|av|Av))([.!?\u2026\u061F\u3002\uFF01\uFF1F]+["')\]»"]*)\s+/gu;
      let sentences = []; 
      let lastIdx = 0; 
      let match;
      
      while ((match = sentenceBoundaryRegex.exec(paragraphText)) !== null) {
        sentences.push(paragraphText.substring(lastIdx, sentenceBoundaryRegex.lastIndex).trim());
        lastIdx = sentenceBoundaryRegex.lastIndex;
      }
      const remainder = paragraphText.substring(lastIdx).trim();
      if (remainder) sentences.push(remainder);
      
      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx];
        currentParagraphWords.push(sentence);
        if (/[.!?\u2026\u3002\uFF01\uFF1F\u061F]/.test(sentence)) {
          currentParagraphPeriods++;
          randomPeriodLimit = getDeterministicLimit(sentence);
        }
        const currentWordCount = currentParagraphWords.join(" ").split(/\s+/).length;
        if (currentParagraphPeriods >= randomPeriodLimit || currentWordCount > 80) {
          processedParagraphs.push(currentParagraphWords.join(" "));
          currentParagraphWords = []; 
          currentParagraphPeriods = 0; 
          randomPeriodLimit = 4;
        }
      }
      const currentAccumulatedWordCount = currentParagraphWords.join(" ").split(/\s+/).filter(Boolean).length;
      if (currentAccumulatedWordCount >= 25 && currentParagraphWords.length > 0) {
        processedParagraphs.push(currentParagraphWords.join(" "));
        currentParagraphWords = []; 
        currentParagraphPeriods = 0; 
        randomPeriodLimit = 4;
      }
    }
    if (currentParagraphWords.length > 0) processedParagraphs.push(currentParagraphWords.join(" "));
    return processedParagraphs.join("\n").replace(/[ \t]+/g, " ").replace(/\n /g, "\n").replace(/ \n/g, "\n").trim();
  }

  function splitIntoFlushableChunks(text, forceFlush = false) {
    let rest = normalizeText(text);
    const chunks = [];
    if (!rest) return { chunks, remainder: "" };

    const sentenceRegex = new RegExp("[^" + SENTENCE_END_CHARS + "]+[" + SENTENCE_END_CHARS + "]+(?:[\"')\\]]+)?", "g");
    let consumedLength = 0; 
    let match;
    
    while ((match = sentenceRegex.exec(rest)) !== null) {
      const sentence = normalizeText(match[0]);
      if (sentence) chunks.push(sentence);
      consumedLength = sentenceRegex.lastIndex;
    }
    rest = normalizeText(rest.slice(consumedLength));

    const PAUSE_CHARS = ",;:،؛、；：\u2026";
    const pauseRegex = new RegExp("[^" + PAUSE_CHARS + "]+[" + PAUSE_CHARS + "]+(?:[\"')\\]]+)?", "g");

    if (isSpacelessScript(rest)) {
      const CHARS_PER_CHUNK = 50;
      while (rest.length >= CHARS_PER_CHUNK) {
        pauseRegex.lastIndex = 0;
        let pauseMatch = pauseRegex.exec(rest);
        if (pauseMatch && pauseMatch[0].length >= 10 && pauseMatch[0].length <= 80) {
            chunks.push(normalizeText(pauseMatch[0]));
            rest = normalizeText(rest.slice(pauseRegex.lastIndex));
        } else {
            chunks.push(rest.slice(0, CHARS_PER_CHUNK));
            rest = rest.slice(CHARS_PER_CHUNK).replace(/^\s+/, "");
        }
      }
    } else {
      const MAX_FALLBACK_WORDS = 15;
      let words = rest.split(/\s+/).filter(Boolean);
      while (words.length >= MAX_FALLBACK_WORDS) {
        pauseRegex.lastIndex = 0;
        let pauseMatch = pauseRegex.exec(rest);
        let matchWordCount = pauseMatch ? pauseMatch[0].split(/\s+/).filter(Boolean).length : 0;
        if (matchWordCount >= 6 && matchWordCount <= 25) {
            chunks.push(normalizeText(pauseMatch[0]));
            rest = normalizeText(rest.slice(pauseRegex.lastIndex));
            words = rest.split(/\s+/).filter(Boolean);
        } else {
            const piece = normalizeText(words.splice(0, MAX_FALLBACK_WORDS).join(" "));
            if (piece) chunks.push(piece);
            rest = normalizeText(words.join(" "));
        }
      }
    }
    if (forceFlush && rest.length) { chunks.push(rest); return { chunks, remainder: "" }; }
    return { chunks, remainder: rest };
  }

  function getCurrentWindowText(segArray) {
    if (!Array.isArray(segArray)) return "";
    return normalizeText(segArray.map((s) => s?.text || "").join(" "));
  }

  function queueTranslation(text) {
    if (!enableGeminiTranslation) return;
    const cleanText = removeInternalRepetitions(normalizeText(text));
    if (!cleanText) return;

    if (translationQueue.length === 0) {
      translationQueue.push(cleanText);
    } else {
      const lastInQueue    = translationQueue[translationQueue.length - 1];
      const newPart        = trimPrefixOverlap(lastInQueue, cleanText, 60, 3);
      const newPartWords   = countWords(newPart);
      const cleanTextWords = countWords(cleanText);
      if (newPartWords < 2 && newPartWords < cleanTextWords) {
        translationQueue[translationQueue.length - 1] = cleanText;
      } else {
        translationQueue.push(cleanText);
      }
    }

    const queued    = translationQueue.join(" ");
    const wordCount = countWords(queued);
    const hasSentenceBoundary = SENTENCE_END_RE.test(queued);

    if (!isTranslatingLocal && (wordCount >= activeProfile.translationMinWords || (wordCount >= activeProfile.translationSentenceWords && hasSentenceBoundary) || wordCount > 60)) {
      processTranslationQueue();
    }
  }

  function processTranslationQueue() {
    if (isTranslatingLocal || translationQueue.length === 0) return;
    const MAX_SOURCE_CHARS = 400;
    let text = ""; 
    let consumed = 0;
    
    while (consumed < translationQueue.length) {
      const next = translationQueue[consumed];
      const candidate = text ? text + " " + next : next;
      if (text && candidate.length > MAX_SOURCE_CHARS) break;
      text = candidate; 
      consumed++;
    }
    
    translationQueue.splice(0, consumed);
    isTranslatingLocal = true;

    const recentTranslated = translatedChunks.slice(-3).join(" ");
    let shownTail;
    if (isSpacelessScript(recentTranslated)) {
      shownTail = recentTranslated.replace(/\s+/g, "").slice(-20);
    } else {
      shownTail = recentTranslated.split(/\s+/).filter(Boolean).slice(-8).join(" ");
    }

    chrome.runtime.sendMessage({ action: "processTranslation", text, shownTail, skipTts: true }, (response) => {
      const runtimeErr = chrome.runtime.lastError?.message || "";
      isTranslatingLocal = false;
      
      if (!runtimeErr && response?.success) {
        if (response.data) {
           const acceptedText = addTranslatedChunk(response.data);
           if (acceptedText && enableTts) {
               chrome.storage.local.get(["targetLanguage", "ttsSpeed"], (cfg) => {
                   chrome.runtime.sendMessage({ 
                       action: 'speakTranslatedText', 
                       text: acceptedText, 
                       lang: cfg.targetLanguage
                   });
               });
           }
        }
        if (response.geminiError) updateHeaderStatusText(`GT fallback — Gemini: ${response.geminiError}`);
        else updateHeaderStatusText("Translation Active");
      } else {
        const errMsg = response?.error || runtimeErr || "Translation failed";
        updateHeaderStatusText(`Translation Error: ${errMsg}`);
        translationQueue.unshift(text);
      }
      if (translationQueue.length > 0) setTimeout(processTranslationQueue, 100);
    });
  }

  function addTranslatedChunk(text) {
    const clean = normalizeText(removeInternalRepetitions(normalizeText(text), 4));
    if (!clean) { renderText(); return null; }
    const recentHistory = translatedChunks.slice(-15).join(" ");
    let deduped = clean;
    
    if (recentHistory) {
      deduped = trimPrefixOverlap(recentHistory, clean, 60, 2);
    }
    
    if (!deduped) { renderText(); return null; }

    const isDuplicate = translatedChunks.slice(-10).some(chunk => calculateTextSimilarity(chunk, deduped) > 0.85);
    if (isDuplicate) { renderText(); return null; }

    const recentFull = stripPunctuation(translatedChunks.slice(-20).join(" "));
    const dedupStripped = stripPunctuation(deduped);
    if (dedupStripped.length > 15 && recentFull.includes(dedupStripped)) { 
      renderText(); return null; 
    }

    translatedChunks.push(deduped);
    if (translatedChunks.length > 5000) translatedChunks.shift();
    renderText();
    return deduped;
  }

  function appendCommittedChunk(text) {
      const originalText = String(text);
      const incoming = normalizeText(text);
      if (!incoming) return false;

      const isDevanagari = /[\u0900-\u097F]/.test(incoming);

      const allHistory = isDevanagari ? historyChunks.slice(-10) : [...dedupTail, ...historyChunks];
      
      let deduped = trimPrefixOverlap(allHistory.slice(-12).join(' '), incoming);
      deduped = normalizeText(deduped);
      if (!deduped) return false;

      if (isDevanagari) {
          const joinedHistory = allHistory.join(' ');
          
          const historyStripped = stripPunctuation(joinedHistory);
          const dedupedStripped = stripPunctuation(deduped);
          if (dedupedStripped.length > 15 && historyStripped.includes(dedupedStripped)) return false;

          const containment = calculateBigramContainment(joinedHistory, deduped);
          if (containment >= 0.65) return false;
          
          const maxSim = allHistory.slice(-5).reduce((max, c) => Math.max(max, calculateTextSimilarity(c, deduped)), 0);
          if (maxSim >= 0.78) return false;
      } else {
          const lastChunks = allHistory.slice(-20).join(' ');
          if (calculateTextSimilarity(lastChunks, deduped) >= activeProfile.similarityThreshold) return false;
      }

      const dedupedStripped = stripPunctuation(deduped);
      const recentHistoryStripped = stripPunctuation(allHistory.slice(-15).join(' '));
      
      if (countWords(deduped) <= 8) {
          if (dedupedStripped && recentHistoryStripped.includes(dedupedStripped)) return false;
      } else if (countWords(deduped) <= 3) {
          if (dedupedStripped && recentHistoryStripped.includes(dedupedStripped)) return false;
      }

      const startAnchor = stripPunctuation(normalizeText(deduped).split(' ').slice(0, 7).join(' '));
      if (!isDevanagari && startAnchor.split(' ').length >= 5) {
          const historySearchable = stripPunctuation(allHistory.slice(-30).join(' '));
          if (historySearchable.includes(startAnchor)) return false;
      }

      const rawDeduped = trimPrefixOverlapRaw(allHistory.slice(-12).join(' '), originalText);
      
      historyChunks.push(deduped); 
      historyChunksRaw.push(rawDeduped);
      if (historyChunks.length > 5000) { 
        historyChunks.shift(); 
        historyChunksRaw.shift(); 
      }
      
      if (enableGeminiTranslation) queueTranslation(deduped);
      else if (enableTts) chrome.runtime.sendMessage({ action: 'speakOriginalText', text: deduped });
      
      return true;
  }

  function absorbStableText(text, forceFlush = false) {
    pendingStableText = normalizeText(`${pendingStableText ? `${pendingStableText} ` : ""}${text || ""}`);
    if (!pendingStableText) return;
    const { chunks, remainder } = splitIntoFlushableChunks(pendingStableText, forceFlush);
    for (const chunk of chunks) appendCommittedChunk(chunk);
    pendingStableText = remainder;
  }

  function updateHistory(newSegments) {
    if (!Array.isArray(newSegments) || newSegments.length === 0) return;
    lastReceivedTime = Date.now();

    const transferFlags = () => {
      for (let i = 0; i < newSegments.length; i++) {
        const rawNew = newSegments[i]?.text || "";
        const foundIdx = previousSegments.findIndex(s => isFuzzyMatch(s?.text || "", rawNew));
        if (foundIdx !== -1) {
          newSegments[i]._committed = previousSegments[foundIdx]._committed;
          newSegments[i]._dropCount = previousSegments[foundIdx]._dropCount;
        }
      }
    };

    if (!previousSegments.length) {
      previousSegments = newSegments.slice();
      windowStartTime = Date.now();
      return;
    }

    const P = activeProfile;
    const currentWindowText = getCurrentWindowText(newSegments);
    const wordCount = countWords(currentWindowText);
    const elapsed = Date.now() - windowStartTime;
    const isDevanagariWindow = /[\u0900-\u097F]/.test(currentWindowText);
    const effectiveStableElapsed = isDevanagariWindow ? Math.min(P.stableElapsed, 1500) : P.stableElapsed;
    const isStable = wordCount >= P.stableWordCount || elapsed >= effectiveStableElapsed || newSegments.length >= P.stableSegments;

    if (!isStable) {
      transferFlags();
      previousSegments = newSegments.slice();
      return;
    }

    let alignmentShift = -1;
    const samplesToTry = Math.min(P.alignmentSamples, newSegments.length);

    for (let i = 0; i < samplesToTry; i++) {
      const newSegText = newSegments[i]?.text || "";
      if (!stripPunctuation(newSegText)) continue;
      const foundIdx = previousSegments.findIndex(s => isFuzzyMatch(s?.text || "", newSegText));
      if (foundIdx !== -1) { 
        alignmentShift = foundIdx - i; 
        break; 
      }
    }

    if (alignmentShift >= 0) {
      for (let i = 0; i < alignmentShift; i++) {
        const seg = previousSegments[i];
        if (seg && !seg._committed && seg.text && seg.text.trim()) {
          const committed = appendCommittedChunk(seg.text.trim());
          if (committed) {
            seg._committed = true;
          } else {
            seg._dropCount = (seg._dropCount || 0) + 1;
            if (seg._dropCount >= 5) seg._committed = true;
          }
        }
      }

      for (let i = 0; i < newSegments.length; i++) {
        const prevIdx = i + alignmentShift;
        if (prevIdx < previousSegments.length) {
          newSegments[i]._committed = previousSegments[prevIdx]._committed;
          newSegments[i]._dropCount = previousSegments[prevIdx]._dropCount;
        } else {
          const rawNew = newSegments[i]?.text || "";
          const fallbackIdx = previousSegments.findIndex(s => isFuzzyMatch(s?.text || "", rawNew));
          if (fallbackIdx !== -1) {
             newSegments[i]._committed = previousSegments[fallbackIdx]._committed;
             newSegments[i]._dropCount = previousSegments[fallbackIdx]._dropCount;
          }
        }
      }

      if (newSegments.length >= P.safeCommitMinSeg || elapsed > P.safeCommitElapsed) {
        const effectiveSafeKeep = newSegments.length <= 2 ? Math.max(0, newSegments.length - 1) : P.safeCommitKeep;
        const safeToCommit = Math.max(0, newSegments.length - effectiveSafeKeep);
        
        for (let i = 0; i < safeToCommit; i++) {
          const seg = newSegments[i];
          if (!seg._committed && seg.text && seg.text.trim()) {
            const committed = appendCommittedChunk(seg.text.trim());
            if (committed) {
              seg._committed = true;
            } else {
              seg._dropCount = (seg._dropCount || 0) + 1;
              if (seg._dropCount >= 5) seg._committed = true;
            }
          }
        }
        windowStartTime = Date.now();
      }
      previousSegments = newSegments.slice();

    } else {
      const effectiveFallbackElapsed = isDevanagariWindow ? Math.min(P.fallbackElapsed, 1800) : P.fallbackElapsed;
      if (elapsed > effectiveFallbackElapsed) {
        previousSegments.forEach(seg => {
          if (seg && !seg._committed && seg.text && seg.text.trim()) {
            const committed = appendCommittedChunk(seg.text.trim());
            if (committed) {
              seg._committed = true;
            } else {
              seg._dropCount = (seg._dropCount || 0) + 1;
              if (seg._dropCount >= 5) seg._committed = true;
            }
          }
        });
        transferFlags();
        previousSegments = newSegments.slice();
        windowStartTime = Date.now();
      } else {
        transferFlags();
        previousSegments = newSegments.slice();
      }
    }
  }

  function getVisibleOriginalText() {
    if (currentFormatting === "none") {
      const recentRaw = historyChunksRaw.map(c => String(c || "").trim()).filter(Boolean).join("\n");
      return recentRaw + (pendingStableText ? "\n" + pendingStableText.trim() : "");
    }
    let joined = historyChunks.join(" ");
    joined = joined.replace(/\n\s+/g, "\n");
    return normalizeText(`${joined}${pendingStableText ? ` ${pendingStableText}` : ""}`);
  }

  function applyDisplayMode() {
    if (!transcriptionOriginalEl || !transcriptionTranslatedEl || !dividerEl) return;
    
    if (contentWrapper) {
      contentWrapper.style.display       = "flex";
      contentWrapper.style.flexDirection = "column";
      contentWrapper.style.flex          = "1 1 0%";
      contentWrapper.style.overflow      = "hidden";
    }
    
    transcriptionOriginalEl.style.overflowY = "auto";
    transcriptionTranslatedEl.style.overflowY = "auto";

    const hasTransHistory = isSubtitleMode ? subtitleTranslatedHistory.length > 0 : translatedChunks.length > 0;
    const isTransActive = enableGeminiTranslation || hasTransHistory;

    let showOrig = currentDisplayMode === "original" || currentDisplayMode === "both";
    let showTrans = currentDisplayMode === "translation" || currentDisplayMode === "both";

    if (showTrans && !isTransActive) { 
      showOrig = true; 
      showTrans = false; 
    }

    if (showOrig && !showTrans) {
      transcriptionOriginalEl.style.display = "block"; 
      transcriptionOriginalEl.style.flex = "1 1 0%";
      transcriptionTranslatedEl.style.display = "none"; 
      dividerEl.style.display = "none";
    } else if (!showOrig && showTrans) {
      transcriptionOriginalEl.style.display = "none"; 
      dividerEl.style.display = "none";
      transcriptionTranslatedEl.style.display = "block"; 
      transcriptionTranslatedEl.style.flex = "1 1 0%";
    } else {
      transcriptionOriginalEl.style.display = "block"; 
      transcriptionTranslatedEl.style.display = "block";
      dividerEl.style.display = "block";
      if (!transcriptionOriginalEl.style.flex || transcriptionOriginalEl.style.flex === "0 1 0%") {
        transcriptionOriginalEl.style.flex = "1 1 0%";
      }
      if (!transcriptionTranslatedEl.style.flex || transcriptionTranslatedEl.style.flex === "0 1 0%") {
        transcriptionTranslatedEl.style.flex = "1 1 0%";
      }
    }
  }

  function clearSilenceMonitor() { 
    if (silenceFlushTimer) { clearInterval(silenceFlushTimer); silenceFlushTimer = null; } 
  }

  function stopTtsNow() {
    try { chrome.tts?.stop(); } catch (e) {}
    try { window.speechSynthesis?.cancel(); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: "stopTts" }); } catch (e) {}
  }

  function startSilenceMonitor() {
    clearSilenceMonitor();
    const P = activeProfile;
    silenceFlushTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastReceivedTime > P.silenceFlushMs) {
        if (previousSegments.length > 0) {
          previousSegments.forEach(seg => {
            if (seg && !seg._committed && seg.text && seg.text.trim()) {
              appendCommittedChunk(seg.text.trim());
              seg._committed = true;
            }
          });
          previousSegments = []; 
          segments = []; 
          renderText();
        } else if (pendingStableText) {
          absorbStableText("", true); 
          renderText();
        }
        
        if (translationQueue.length > 0 && !isTranslatingLocal && now - lastReceivedTime > P.translationSilenceMs) {
          processTranslationQueue();
        }
      }
    }, P.silenceCheckMs);
  }

  function updateStatusBar(settings) {
    if (!statusLineEl) return;
    statusLineEl.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;white-space:nowrap;min-width:0;padding:2px 8px;min-height:22px;width:100%;box-sizing:border-box;";
    
    const target = (settings.targetLanguage || "ES").toUpperCase(); 
    const tts = settings.enableTts ? "ON" : "OFF";
    const geminiOn = enableGeminiTranslation; 
    const geminiModel = settings.geminiModel || "";
    const G = "#4ade80"; 
    const M = "#94a3b8"; 
    const statusText = window.__transcriptionStatusText || "";
    const isError = statusText && (statusText.toLowerCase().includes("error") || statusText.toLowerCase().includes("fallback"));
    const statusBg = isError ? "rgba(220,38,38,0.25)" : "rgba(34,197,94,0.18)";
    const statusBorder = isError ? "rgba(248,113,113,0.4)" : "rgba(74,222,128,0.35)";
    const statusColor = isError ? "#fca5a5" : "#86efac"; 
    const versionText = MANIFEST_VERSION ? ` · v${MANIFEST_VERSION}` : "";

    const pill = (label, value, active = true) => `<span style="white-space:nowrap;"><span style="color:${M};">${label}&nbsp;</span><span style="color:${active ? G : M};">${escapeHtml(value)}</span></span>`;
    const sep = `<span style="color:#475569;padding:0 4px;font-size:10px;">·</span>`;
    let statsHtml = "";

    if (isSubtitleMode) {
      const lang = (currentTrackLang || "AUTO").toUpperCase().split('-')[0];
      statsHtml = pill("Mode", "Subtitles") + sep + pill("Language", lang) + sep + pill("Gemini", geminiOn ? "ON" : "OFF") + sep + (geminiOn && geminiModel ? pill("Model", geminiModel) + sep : "") + pill("Target", target) + sep + pill("TTS", tts) + `<span style="color:#475569;">${escapeHtml(versionText)}</span>`;
    } else {
      const model = (settings.selectedModelSize || "small").toLowerCase(); 
      const lang = (settings.selectedLanguage || "AUTO").toUpperCase();
      const task = settings.selectedTask === "translate" ? "TRANSLATE" : "TRANSCRIBE"; 
      const vad = settings.useVad ? "ON" : "OFF";
      statsHtml = pill("Model", model) + sep + pill("Language", lang) + sep + pill("Task", task) + sep + pill("Gemini", geminiOn ? "ON" : "OFF") + sep + (geminiOn && geminiModel ? pill("Model", geminiModel) + sep : "") + pill("Target", target) + sep + pill("VAD", vad) + sep + pill("TTS", tts) + `<span style="color:#475569;">${escapeHtml(versionText)}</span>`;
    }

    statusLineEl.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${statsHtml}</span><span title="${escapeHtml(statusText || '').replace(/"/g, '&quot;')}" style="flex-shrink:0;padding:2px 8px;border-radius:999px;background:${statusBg};border:1px solid ${statusBorder};color:${statusColor};font-weight:700;font-size:10px;white-space:nowrap;max-width:350px;overflow:hidden;text-overflow:ellipsis;display:inline-block;visibility:${statusText ? 'visible' : 'hidden'};">${escapeHtml(statusText || 'Idle')}</span>`;
  }

  function updateHeaderStatusText(text) {
    window.__transcriptionStatusText = text;
    if (statusClearTimer) clearTimeout(statusClearTimer);
    const keys = ["selectedModelSize", "selectedLanguage", "selectedTask", "targetLanguage", "useVad", "enableTts", "geminiModel"];
    statusClearTimer = setTimeout(() => {
      window.__transcriptionStatusText = ""; 
      chrome.storage.local.get(keys, (res) => updateStatusBar(res || {}));
    }, 5000);
    chrome.storage.local.get(keys, (res) => updateStatusBar(res || {}));
  }

  function applyFontSize(size) {
    currentFontSize = Math.max(12, size);
    const lineHeight = `${Math.round(currentFontSize * 1.25)}px`;
    if (transcriptionOriginalEl) { 
      transcriptionOriginalEl.style.fontSize = `${currentFontSize}px`; 
      transcriptionOriginalEl.style.lineHeight = lineHeight; 
    }
    if (transcriptionTranslatedEl) { 
      transcriptionTranslatedEl.style.fontSize = `${Math.max(12, Math.round(currentFontSize * 0.92))}px`; 
      transcriptionTranslatedEl.style.lineHeight = lineHeight; 
    }
    chrome.storage.local.set({ fontSize: currentFontSize });
  }

  function resetGlobalState(isSubMode = false) {
    segments = []; 
    previousSegments = []; 
    dedupTail = historyChunks.slice(-40);
    historyChunks = []; 
    historyChunksRaw = []; 
    translatedChunks = []; 
    pendingStableText = "";
    windowStartTime = Date.now(); 
    lastReceivedTime = Date.now(); 
    translationQueue = []; 
    isTranslatingLocal = false;
    isSubtitleMode = !!isSubMode; 
    currentTrackLang = ""; 
    subtitleOriginalHistory = []; 
    subtitleTranslatedHistory = [];
    if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null; }
    window.__transcriptionStatusText = ""; 
    try { chrome.runtime.sendMessage({ action: "resetTranslationContext" }); } catch (e) {}
  }

  function handleTranscriptPayload(raw) {
    if (isSubtitleMode) return;
    isSubtitleMode = false;
    
    let parsed; 
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { parsed = null; }
    segments = Array.isArray(parsed?.segments) ? parsed.segments : []; 
    lastReceivedTime = Date.now();

    chrome.storage.local.get(
      ["displayMode", "textFormatting", "fontSize", "selectedModelSize", "selectedLanguage",
       "selectedTask", "targetLanguage", "useVad", "enableTts", "enableGeminiTranslation", "geminiModel",
       "transcriptionProfile", "hideLiveText"],
      (res) => {
        currentDisplayMode = res.displayMode || "both"; 
        currentFormatting = res.textFormatting || "advanced";
        enableGeminiTranslation = !!res.enableGeminiTranslation; 
        enableTts = !!res.enableTts; 
        hideLiveText = !!res.hideLiveText;
        
        const newProfile = getProfile(res.transcriptionProfile || "balanced");
        if (newProfile !== activeProfile) { 
          activeProfile = newProfile; 
          startSilenceMonitor(); 
        }
        
        applyFontSize(res.fontSize || currentFontSize || 20); 
        updateStatusBar(res || {}); 
        renderText();
      }
    );
  }

  dividerEl.addEventListener("mousedown", (e) => {
    if (currentDisplayMode !== "both" || (!enableGeminiTranslation && !isSubtitleMode)) return;
    isDraggingDivider = true; 
    document.body.style.cursor = "row-resize";
    const headerHeight = transcriptionHeaderEl.offsetHeight || 0;
    const startY = e.clientY; 
    const startH = transcriptionOriginalEl.offsetHeight;
    const totalH = contentWrapper.offsetHeight - headerHeight;
    
    const onMouseMove = (ev) => {
      const delta = ev.clientY - startY; 
      const newH = Math.max(40, Math.min(totalH - 40, startH + delta));
      const ratio = newH / totalH;
      transcriptionOriginalEl.style.flex = `${ratio} 1 0%`; 
      transcriptionTranslatedEl.style.flex = `${1 - ratio} 1 0%`;
    };
    
    const onMouseUp = () => {
      isDraggingDivider = false; 
      document.body.style.cursor = "default";
      document.removeEventListener("mousemove", onMouseMove); 
      document.removeEventListener("mouseup", onMouseUp);
      const headerHeightNow = transcriptionHeaderEl.offsetHeight || 0;
      const ratio = transcriptionOriginalEl.offsetHeight / Math.max(1, contentWrapper.offsetHeight - headerHeightNow);
      chrome.storage.local.set({ dividerPos: ratio });
    };
    
    document.addEventListener("mousemove", onMouseMove); 
    document.addEventListener("mouseup", onMouseUp);
  });

  btnDecrease.addEventListener("click", () => { applyFontSize(currentFontSize - 2); renderText(); });
  btnIncrease.addEventListener("click", () => { applyFontSize(currentFontSize + 2); renderText(); });
  btnCopy.addEventListener("click", async () => {
    const text = `Original:\n${transcriptionOriginalEl?.innerText || ""}\n\nTranslation:\n${transcriptionTranslatedEl?.innerText || ""}`;
    try { await navigator.clipboard.writeText(text); } catch (e) {}
  });

  function renderBlock(el, text, extraStyle = "") {
    if (!el) return;
    el.innerHTML = `<span style="${TEXT_BLOCK_STYLE}${extraStyle}">${escapeHtml(text)}</span>`;
  }

  function renderText() {
    if (isSubtitleMode) {
      applyDisplayMode();
      if (transcriptionOriginalEl) {
        const allOrig = subtitleOriginalHistory;
        const fullOrigText = formatText(allOrig.join(' '), currentFormatting);
        transcriptionOriginalEl.innerHTML = `<span style="${TEXT_BLOCK_STYLE}">${escapeHtml(fullOrigText).replace(/\n/g, "<br>")}</span>`;
        transcriptionOriginalEl.scrollTop = transcriptionOriginalEl.scrollHeight;
      }
      if (transcriptionTranslatedEl) {
        const allTrans = subtitleTranslatedHistory;
        let histHtml = '';
        let lastHtml = '';
        if (allTrans.length > 0) {
          const histText = allTrans.slice(0, -1).join(' ');
          if (histText) {
            const histFormatted = formatText(histText, currentFormatting);
            histHtml = `<span style="opacity:0.55;color:#a7f3d0;font-style:italic;">${escapeHtml(histFormatted).replace(/\n/g, '<br>')}</span><br>`;
          }
          const currText = allTrans[allTrans.length - 1] || '';
          const currFormatted = formatText(currText, currentFormatting);
          lastHtml = `<span style="color:#a7f3d0;font-style:italic;font-weight:600;">${escapeHtml(currFormatted).replace(/\n/g, '<br>')}</span>`;
        }
        transcriptionTranslatedEl.innerHTML = `<span style="${TEXT_BLOCK_STYLE}">${histHtml}${lastHtml}</span>`;
        transcriptionTranslatedEl.scrollTop = transcriptionTranslatedEl.scrollHeight;
      }
      return;
    }
    
    if (!transcriptionOriginalEl || !transcriptionTranslatedEl) return;
    updateHistory(segments);

    const committedText = getVisibleOriginalText();
    const originalFormatted = formatText(committedText, currentFormatting);

    let livePreviewHtml = "";
    if (!hideLiveText && segments.length > 0) {
      const liveRaw = normalizeText(getCurrentWindowText(segments));
      if (liveRaw) {
        const historyTail = normalizeText(committedText).split(/\s+/).slice(-60).join(" ");
        const trimmed = normalizeText(trimPrefixOverlap(historyTail, liveRaw, 80, 2));
        if (trimmed) {
          const liveFormatted = formatText(trimmed, currentFormatting);
          const liveLines = liveFormatted.split("\n");
          const liveCapped = liveLines.slice(-3).join("\n");
          livePreviewHtml = `<span style="opacity:0.35;font-style:italic;">${escapeHtml(liveCapped)}</span>`;
        }
      }
    }

    if (transcriptionOriginalEl) transcriptionOriginalEl.innerHTML = `<span style="${TEXT_BLOCK_STYLE}">${escapeHtml(originalFormatted)}${livePreviewHtml ? "\n" + livePreviewHtml : ""}</span>`;

    const translatedFull = formatText(normalizeText(translatedChunks.join(" ")), currentFormatting);
    renderBlock(transcriptionTranslatedEl, translatedFull, "color:#a7f3d0;font-style:italic;");

    applyDisplayMode();
    if (transcriptionOriginalEl) transcriptionOriginalEl.scrollTop = transcriptionOriginalEl.scrollHeight;
    if (transcriptionTranslatedEl) transcriptionTranslatedEl.scrollTop = transcriptionTranslatedEl.scrollHeight;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return false;
    try {
      if (request.type === "resetSession") { 
        resetGlobalState(request.isSubtitleMode); 
        startSilenceMonitor(); 
        renderText(); 
        sendResponse({ success: true }); 
        return true; 
      }
      if (request.type === "transcript") { 
        handleTranscriptPayload(request.data); 
        sendResponse({ success: true }); 
        return true; 
      }
      if (request.type === "translationResult") { 
        addTranslatedChunk(request.data); 
        sendResponse({ success: true }); 
        return true; 
      }
      if (request.type === "subtitle_display") {
        isSubtitleMode = true;
        if (request.data.trackLang !== undefined) currentTrackLang = request.data.trackLang;
        
        const orig = request.data.original ? request.data.original.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "") : request.data.original;
        const trans = request.data.translated; 
        const statusText = request.data.statusText;
        
        if (orig) { 
          const lastOrig = subtitleOriginalHistory[subtitleOriginalHistory.length - 1]; 
          if (orig !== lastOrig) subtitleOriginalHistory.push(orig); 
        }
        if (trans) { 
          const lastTrans = subtitleTranslatedHistory[subtitleTranslatedHistory.length - 1]; 
          if (trans !== lastTrans) subtitleTranslatedHistory.push(trans); 
        }
        
        if (statusText !== undefined) {
          updateHeaderStatusText(statusText);
        } else {
          chrome.storage.local.get(["selectedModelSize", "selectedLanguage", "selectedTask", "targetLanguage", "useVad", "enableTts", "geminiModel"], (res) => { 
            if (typeof updateStatusBar === 'function') updateStatusBar(res || {}); 
          });
        }
        renderText(); 
        applyDisplayMode(); 
        sendResponse({ success: true }); 
        return true;
      }
      
      if (request.action === "clearSubtitleHistory") {
        if (isSubtitleMode) {
          subtitleOriginalHistory = [];
          subtitleTranslatedHistory = [];
          renderText();
        }
        sendResponse({ success: true });
        return true;
      }

      if (request.type === "clearWhisperBuffers") {
        segments = [];
        previousSegments = [];
        historyChunks = [];
        historyChunksRaw = [];
        translatedChunks = [];
        dedupTail = [];
        pendingStableText = "";
        lastReceivedTime = Date.now();
        windowStartTime = Date.now();
        translationQueue = [];
        isTranslatingLocal = false;
        try { chrome.runtime.sendMessage({ action: "stopTts", isSeek: true }); } catch(e){}
        renderText();
        sendResponse({ success: true });
        return true;
      }

      if (request.type === "STOP") { 
        stopTtsNow(); 
        resetGlobalState(false); 
        clearSilenceMonitor(); 
        sendResponse({ success: true }); 
        window.close(); 
        return true; 
      }
      return false;
    } catch (e) { 
      sendResponse({ success: false, error: e.message }); 
      return true; 
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let needsRender = false;
    
    if ("enableGeminiTranslation" in changes) { 
      enableGeminiTranslation = !!changes.enableGeminiTranslation.newValue; 
      if (!enableGeminiTranslation) { 
        translatedChunks = []; 
        translationQueue = []; 
        isTranslatingLocal = false; 
      } 
      needsRender = true; 
    }
    if ("enableTts" in changes) { 
      enableTts = !!changes.enableTts.newValue; 
      needsRender = true; 
    }
    if ("displayMode" in changes) { 
      currentDisplayMode = changes.displayMode.newValue || "both"; 
      needsRender = true; 
    }
    if ("textFormatting" in changes) { 
      currentFormatting = changes.textFormatting.newValue || "advanced"; 
      needsRender = true; 
    }
    if ("hideLiveText" in changes) { 
      hideLiveText = !!changes.hideLiveText.newValue; 
      needsRender = true; 
    }
    if ("transcriptionProfile" in changes) { 
      activeProfile = getProfile(changes.transcriptionProfile.newValue || "balanced"); 
      startSilenceMonitor(); 
      needsRender = true; 
    }
    if (needsRender) renderText();
  });

  window.addEventListener("beforeunload", () => { stopTtsNow(); });

  chrome.storage.local.get(
    ["textFormatting", "displayMode", "fontSize", "dividerPos", "selectedModelSize",
     "selectedLanguage", "selectedTask", "targetLanguage", "useVad", "enableTts",
     "enableGeminiTranslation", "geminiModel", "transcriptionProfile", "hideLiveText", "isSubtitleTtsActive"],
    (res) => {
      currentFormatting = res.textFormatting || "advanced"; 
      currentDisplayMode = res.displayMode || "both";
      enableGeminiTranslation = !!res.enableGeminiTranslation; 
      enableTts = !!res.enableTts; 
      hideLiveText = !!res.hideLiveText;
      activeProfile = getProfile(res.transcriptionProfile || "balanced"); 
      applyFontSize(res.fontSize || 20);
      
      if (res.isSubtitleTtsActive) isSubtitleMode = true;
      
      const pos = parseFloat(res.dividerPos);
      if (Number.isFinite(pos) && pos > 0.1 && pos < 0.9) {
        if (transcriptionOriginalEl) transcriptionOriginalEl.style.flex = `${pos} 1 0%`;
        if (transcriptionTranslatedEl) transcriptionTranslatedEl.style.flex = `${1 - pos} 1 0%`;
      }
      
      updateStatusBar(res || {}); 
      applyDisplayMode(); 
      renderText(); 
      startSilenceMonitor();
    }
  );
})();
