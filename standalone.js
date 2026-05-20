/*
 *standalone.js — part of Audio Transcription
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
      stableWordCount: 15,
      stableElapsed: 4000,
      stableSegments: 7,
      safeCommitKeep: 3,
      safeCommitMinSeg: 5,
      safeCommitElapsed: 5000,
      fallbackElapsed: 6000,
      silenceFlushMs: 2000,
      silenceCheckMs: 1000,
      translationMinWords: 20,
      translationSentenceWords: 14,
      translationSilenceMs: 2500,
      alignmentSamples: 4
    },
    balanced: {
      stableWordCount: 10,
      stableElapsed: 2500,
      stableSegments: 5,
      safeCommitKeep: 2,
      safeCommitMinSeg: 4,
      safeCommitElapsed: 3500,
      fallbackElapsed: 4000,
      silenceFlushMs: 1200,
      silenceCheckMs: 800,
      translationMinWords: 16,
      translationSentenceWords: 10,
      translationSilenceMs: 1500,
      alignmentSamples: 6
    },
    lowlag: {
      stableWordCount: 5,
      stableElapsed: 1200,
      stableSegments: 3,
      safeCommitKeep: 1,
      safeCommitMinSeg: 2,
      safeCommitElapsed: 1500,
      fallbackElapsed: 2000,
      silenceFlushMs: 600,
      silenceCheckMs: 400,
      translationMinWords: 8,
      translationSentenceWords: 5,
      translationSilenceMs: 800,
      alignmentSamples: 8
    }
  };
  let activeProfile = PROFILES.balanced;

  function getProfile(name) {
    return PROFILES[name] || PROFILES.balanced;
  }

  function normalizeText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function splitWords(text) { return stripPunctuation(text).split(" ").filter(Boolean); }
  function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }
  function stripPunctuation(text) {
    return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  }

  const SPACELESS_RE = /[\u3040-\u9FFF\uF900-\uFAFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF]/;
  const SENTENCE_END_CHARS = ".!?\u2026\u3002\uFF01\uFF1F\u3001\u061F\u060C\u061B\u0964\u0965\u104A\u104B\u17D4\u1362\u0589";
  const SENTENCE_END_RE = new RegExp("[" + SENTENCE_END_CHARS + "]");

  function isSpacelessScript(text) {
    return SPACELESS_RE.test(text);
  }

  function countWords(text) {
    const t = normalizeText(text);
    if (!t) return 0;
    const spaceWords     = t.split(/\s+/).filter(Boolean).length;
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
      for (const char of setB) {
        if (setA.has(char)) intersection++;
      }
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

  function trimPrefixOverlap(baseText, candidateText, maxWords = 80, minWords = 3) {
    const isSpaceless = isSpacelessScript(baseText) || isSpacelessScript(candidateText);
    if (isSpaceless) {
      const cleanBase = baseText.replace(/\s+/g, "");
      const cleanCand = candidateText.replace(/\s+/g, "");
      const maxChars = Math.min(100, cleanBase.length, cleanCand.length);
      const minChars = 2;
      for (let size = maxChars; size >= minChars; size--) {
        const suffix = cleanBase.slice(-size);
        const prefix = cleanCand.slice(0, size);
        if (suffix === prefix) {
          let charsMatched = 0;
          let candIdx = 0;
          while (candIdx < candidateText.length && charsMatched < size) {
            if (!/\s/.test(candidateText[candIdx])) {
              charsMatched++;
            }
            candIdx++;
          }
          return normalizeText(candidateText.slice(candIdx));
        }
      }
      for (let size = maxChars; size >= Math.max(4, minChars); size--) {
        const suffix = cleanBase.slice(-size);
        const idx = cleanCand.indexOf(suffix);
        if (idx !== -1) {
          let charsMatched = 0;
          let candIdx = 0;
          const targetCharCount = idx + size;
          while (candIdx < candidateText.length && charsMatched < targetCharCount) {
            if (!/\s/.test(candidateText[candIdx])) {
              charsMatched++;
            }
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
      let ok = true;
      for (let i = 0; i < size; i++) {
        if (baseWords[baseWords.length - size + i] !== candidateWords[i]) { ok = false; break; }
      }
      if (ok) return rawCandidateWords.slice(size).join(" ").trim();
    }

    const minAnywhere = Math.max(4, minWords);
    for (let size = max; size >= minAnywhere; size--) {
      const suffix = baseWords.slice(baseWords.length - size);
      let matchIdx = -1;
      for (let j = 0; j <= candidateWords.length - size; j++) {
        let match = true;
        for (let k = 0; k < size; k++) {
          if (suffix[k] !== candidateWords[j + k]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchIdx = j;
          break;
        }
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
      const minChars = 2;
      for (let size = maxChars; size >= minChars; size--) {
        const suffix = cleanBase.slice(-size);
        const prefix = cleanCand.slice(0, size);
        if (suffix === prefix) {
          let charsMatched = 0;
          let candIdx = 0;
          while (candIdx < rawCandidateText.length && charsMatched < size) {
            if (!/\s/.test(rawCandidateText[candIdx])) {
              charsMatched++;
            }
            candIdx++;
          }
          return rawCandidateText.slice(candIdx).replace(/^[ \t\r\n]+/, "");
        }
      }
      for (let size = maxChars; size >= Math.max(4, minChars); size--) {
        const suffix = cleanBase.slice(-size);
        const idx = cleanCand.indexOf(suffix);
        if (idx !== -1) {
          let charsMatched = 0;
          let candIdx = 0;
          const targetCharCount = idx + size;
          while (candIdx < rawCandidateText.length && charsMatched < targetCharCount) {
            if (!/\s/.test(rawCandidateText[candIdx])) {
              charsMatched++;
            }
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
      let ok = true;
      for (let i = 0; i < size; i++) {
        if (baseWords[baseWords.length - size + i] !== candidateWords[i]) { ok = false; break; }
      }
      if (ok) {
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
      for (let j = 0; j <= candidateWords.length - size; j++) {
        let match = true;
        for (let k = 0; k < size; k++) {
          if (suffix[k] !== candidateWords[j + k]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchIdx = j;
          break;
        }
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
            if (match) {
              return clean.slice(0, i) + clean.slice(i + len);
            }
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
          if (match) {
            return normalizeText(
              words.slice(0, i).join(" ") + " " + words.slice(i + len).join(" ")
            );
          }
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
    if (formatting === "join") {
      return flat;
    }

    // Advanced: Group sentences into paragraphs dynamically based on original pauses and deterministic limits (3 to 5 periods)
    const getDeterministicLimit = (strText) => {
      let hash = 0;
      const s = String(strText || "");
      for (let idx = 0; idx < s.length; idx++) {
        hash = (hash << 5) - hash + s.charCodeAt(idx);
        hash |= 0;
      }
      return 3 + (Math.abs(hash) % 3); // Return stable, fixed 3, 4, or 5
    };

    const rawParagraphs = flat.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const processedParagraphs = [];
    
    let currentParagraphWords = [];
    let currentParagraphPeriods = 0;
    let randomPeriodLimit = 4; // Stable initial seed limit
    
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
      if (remainder) {
        sentences.push(remainder);
      }
      
      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx];
        currentParagraphWords.push(sentence);
        
        if (/[.!?\u2026\u3002\uFF01\uFF1F\u061F]/.test(sentence)) {
          currentParagraphPeriods++;
          // Calculate a deterministic limit based on the unique character composition of this sentence
          randomPeriodLimit = getDeterministicLimit(sentence);
        }
        
        const currentWordCount = currentParagraphWords.join(" ").split(/\s+/).length;
        
        // Break paragraph if we hit the dynamic deterministic limit or paragraph gets too long
        if (currentParagraphPeriods >= randomPeriodLimit || currentWordCount > 80) {
          processedParagraphs.push(currentParagraphWords.join(" "));
          currentParagraphWords = [];
          currentParagraphPeriods = 0;
          randomPeriodLimit = 4;
        }
      }
      
      // Natural pause boundary: Commit break only if current paragraph has enough content (>25 words)
      // to prevent isolated single-sentence lines.
      const currentAccumulatedWordCount = currentParagraphWords.join(" ").split(/\s+/).filter(Boolean).length;
      if (currentAccumulatedWordCount >= 25 && currentParagraphWords.length > 0) {
        processedParagraphs.push(currentParagraphWords.join(" "));
        currentParagraphWords = [];
        currentParagraphPeriods = 0;
        randomPeriodLimit = 4;
      }
    }
    
    if (currentParagraphWords.length > 0) {
      processedParagraphs.push(currentParagraphWords.join(" "));
    }
    
    return processedParagraphs.join("\n").replace(/[ \t]+/g, " ").replace(/\n /g, "\n").replace(/ \n/g, "\n").trim();
  }

  function splitIntoFlushableChunks(text, forceFlush = false) {
    let rest = normalizeText(text);
    const chunks = [];
    if (!rest) return { chunks, remainder: "" };

    const sentenceRegex = new RegExp(
      "[^" + SENTENCE_END_CHARS + "]+" +
      "[" + SENTENCE_END_CHARS + "]+(?:[\"')\\]]+)?",
      "g"
    );
    let consumedLength = 0;
    let match;

    while ((match = sentenceRegex.exec(rest)) !== null) {
      const sentence = normalizeText(match[0]);
      if (sentence) chunks.push(sentence);
      consumedLength = sentenceRegex.lastIndex;
    }

    rest = normalizeText(rest.slice(consumedLength));

    if (isSpacelessScript(rest)) {
      const CHARS_PER_CHUNK = 20;
      while (rest.length >= CHARS_PER_CHUNK) {
        chunks.push(rest.slice(0, CHARS_PER_CHUNK));
        rest = rest.slice(CHARS_PER_CHUNK).replace(/^\s+/, "");
      }
    } else {
      const words = rest.split(/\s+/).filter(Boolean);
      while (words.length >= 10) {
        const piece = normalizeText(words.splice(0, 10).join(" "));
        if (piece) chunks.push(piece);
      }
      rest = normalizeText(words.join(" "));
    }

    if (forceFlush && rest.length) {
      chunks.push(rest);
      return { chunks, remainder: "" };
    }

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

    if (
      !isTranslatingLocal &&
      (wordCount >= activeProfile.translationMinWords ||
        (wordCount >= activeProfile.translationSentenceWords && hasSentenceBoundary))
    ) {
      processTranslationQueue();
    }
  }

  function processTranslationQueue() {
    if (isTranslatingLocal || translationQueue.length === 0) return;

    const MAX_SOURCE_CHARS = 400;
    let text = "";
    let consumed = 0;
    while (consumed < translationQueue.length) {
      const next      = translationQueue[consumed];
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

    chrome.runtime.sendMessage({ action: "processTranslation", text, shownTail }, (response) => {
      const runtimeErr = chrome.runtime.lastError?.message || "";
      isTranslatingLocal = false;

      if (!runtimeErr && response?.success) {
        if (response.data) {
          addTranslatedChunk(response.data);
        }
        if (response.geminiError) {
          updateHeaderStatusText(`GT fallback — Gemini: ${response.geminiError}`);
        } else {
          updateHeaderStatusText("Translation Active");
        }
      } else {
        const errMsg = response?.error || runtimeErr || "Translation failed";
        updateHeaderStatusText(`Translation Error: ${errMsg}`);
        console.error("Translation failed:", errMsg, response || null);
        translationQueue.unshift(text);
      }

      if (translationQueue.length > 0) {
        setTimeout(processTranslationQueue, 100);
      }
    });
  }

  function addTranslatedChunk(text) {
    const clean = normalizeText(removeInternalRepetitions(normalizeText(text), 4));
    if (!clean) { renderText(); return; }

    const recentHistory = translatedChunks.slice(-15).join(" ");
    let deduped = clean;

    if (recentHistory) {
      deduped = trimPrefixOverlap(recentHistory, clean, 60, 2);
    }

    if (!deduped) { renderText(); return; }

    const isDuplicate = translatedChunks.slice(-10).some(
      chunk => calculateTextSimilarity(chunk, deduped) > 0.85
    );
    if (isDuplicate) { renderText(); return; }

    const recentFull = stripPunctuation(translatedChunks.slice(-20).join(" "));
    const dedupStripped = stripPunctuation(deduped);
    if (dedupStripped.length > 15 && recentFull.includes(dedupStripped)) {
      renderText(); return;
    }

    translatedChunks.push(deduped);
    if (translatedChunks.length > 5000) translatedChunks.shift();
    renderText();
  }

  function appendCommittedChunk(text) {
    const originalText = String(text || "");
    const incoming = normalizeText(text);
    if (!incoming) return;

    const allHistory = [...dedupTail, ...historyChunks];
    let deduped = trimPrefixOverlap(allHistory.slice(-12).join(" "), incoming);
    deduped = normalizeText(deduped);
    if (!deduped) return;

    const lastChunks = allHistory.slice(-6).join(" ");
    if (calculateTextSimilarity(lastChunks, deduped) > 0.80) return;

    if (countWords(deduped) <= 5) {
      const dedupedStripped = stripPunctuation(deduped);
      const recentHistoryStripped = stripPunctuation(allHistory.slice(-50).join(" "));
      if (dedupedStripped && recentHistoryStripped.includes(dedupedStripped)) return;
    }

    const startAnchor = stripPunctuation(normalizeText(deduped).split(/\s+/).slice(0, 7).join(" "));
    if (startAnchor.split(" ").length >= 5) {
      const historySearchable = stripPunctuation(allHistory.slice(-30).join(" "));
      if (historySearchable.includes(startAnchor)) return;
    }

    const rawDeduped = trimPrefixOverlapRaw(allHistory.slice(-12).join(" "), originalText);

    historyChunks.push(deduped);
    historyChunksRaw.push(rawDeduped);
    if (historyChunks.length > 5000) { historyChunks.shift(); historyChunksRaw.shift(); }

    if (enableGeminiTranslation) {
      queueTranslation(deduped);
    } else if (enableTts) {
      chrome.runtime.sendMessage({ action: "speakOriginalText", text: deduped });
    }
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

    if (!previousSegments.length) {
      previousSegments = newSegments.slice();
      windowStartTime = Date.now();
      return;
    }

    const transferFlags = () => {
      for (let i = 0; i < newSegments.length; i++) {
        const rawNew = stripPunctuation(newSegments[i]?.text || "");
        const foundIdx = previousSegments.findIndex(s => stripPunctuation(s?.text || "") === rawNew);
        if (foundIdx !== -1) {
          newSegments[i]._committed = previousSegments[foundIdx]._committed;
        }
      }
    };

    const P = activeProfile;
    const currentWindowText = getCurrentWindowText(newSegments);
    const wordCount = countWords(currentWindowText);
    const elapsed = Date.now() - windowStartTime;
    const isStable = wordCount >= P.stableWordCount || elapsed >= P.stableElapsed || newSegments.length >= P.stableSegments;

    if (!isStable) {
      transferFlags();
      previousSegments = newSegments.slice();
      return;
    }

    let alignmentShift = -1;
    const samplesToTry = Math.min(P.alignmentSamples, newSegments.length);

    for (let i = 0; i < samplesToTry; i++) {
      const newSegText = stripPunctuation(newSegments[i]?.text || "");
      if (!newSegText) continue;
      const foundIdx = previousSegments.findIndex(s => stripPunctuation(s?.text || "") === newSegText);
      if (foundIdx !== -1) {
        alignmentShift = foundIdx - i;
        break;
      }
    }

    if (alignmentShift >= 0) {
      for (let i = 0; i < alignmentShift; i++) {
        const seg = previousSegments[i];
        if (seg && !seg._committed && seg.text && seg.text.trim()) {
          appendCommittedChunk(seg.text.trim());
          seg._committed = true;
        }
      }

      for (let i = 0; i < newSegments.length; i++) {
        const prevIdx = i + alignmentShift;
        if (prevIdx < previousSegments.length) {
          newSegments[i]._committed = previousSegments[prevIdx]._committed;
        } else {
          const rawNew = stripPunctuation(newSegments[i]?.text || "");
          const fallbackIdx = previousSegments.findIndex(s => stripPunctuation(s?.text || "") === rawNew);
          if (fallbackIdx !== -1) newSegments[i]._committed = previousSegments[fallbackIdx]._committed;
        }
      }

      if (newSegments.length >= P.safeCommitMinSeg || elapsed > P.safeCommitElapsed) {
        const safeToCommit = Math.max(0, newSegments.length - P.safeCommitKeep);
        for (let i = 0; i < safeToCommit; i++) {
          const seg = newSegments[i];
          if (!seg._committed && seg.text && seg.text.trim()) {
            appendCommittedChunk(seg.text.trim());
            seg._committed = true;
          }
        }
        windowStartTime = Date.now();
      }

      previousSegments = newSegments.slice();

    } else {
      if (elapsed > P.fallbackElapsed) {
        previousSegments.forEach(seg => {
          if (seg && !seg._committed && seg.text && seg.text.trim()) {
            appendCommittedChunk(seg.text.trim());
            seg._committed = true;
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

    statusLineEl.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;white-space:nowrap;" +
      "min-width:0;padding:2px 8px;min-height:22px;width:100%;box-sizing:border-box;";

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

    const pill = (label, value, active = true) =>
      `<span style="white-space:nowrap;"><span style="color:${M};">${label}&nbsp;</span><span style="color:${active ? G : M};">${escapeHtml(value)}</span></span>`;
    const sep = `<span style="color:#475569;padding:0 4px;font-size:10px;">·</span>`;

    let statsHtml = "";

    if (isSubtitleMode) {
      const lang = (currentTrackLang || "AUTO").toUpperCase().split('-')[0];
      statsHtml =
        pill("Mode", "Subtitles") + sep +
        pill("Language", lang) + sep +
        pill("Gemini", geminiOn ? "ON" : "OFF") + sep +
        (geminiOn && geminiModel ? pill("Model", geminiModel) + sep : "") +
        pill("Target", target) + sep +
        pill("TTS", tts) +
        `<span style="color:#475569;">${escapeHtml(versionText)}</span>`;
    } else {
      const model = (settings.selectedModelSize || "small").toLowerCase();
      const lang = (settings.selectedLanguage || "AUTO").toUpperCase();
      const task = settings.selectedTask === "translate" ? "TRANSLATE" : "TRANSCRIBE";
      const vad = settings.useVad ? "ON" : "OFF";

      statsHtml =
        pill("Model", model) + sep +
        pill("Language", lang) + sep +
        pill("Task", task) + sep +
        pill("Gemini", geminiOn ? "ON" : "OFF") + sep +
        (geminiOn && geminiModel ? pill("Model", geminiModel) + sep : "") +
        pill("Target", target) + sep +
        pill("VAD", vad) + sep +
        pill("TTS", tts) +
        `<span style="color:#475569;">${escapeHtml(versionText)}</span>`;
    }

    statusLineEl.innerHTML =
      `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${statsHtml}</span>` +
      `<span title="${escapeHtml(statusText || '').replace(/"/g, '&quot;')}" style="flex-shrink:0;padding:2px 8px;border-radius:999px;background:${statusBg};border:1px solid ${statusBorder};color:${statusColor};font-weight:700;font-size:10px;white-space:nowrap;max-width:350px;overflow:hidden;text-overflow:ellipsis;display:inline-block;visibility:${statusText ? 'visible' : 'hidden'};">${escapeHtml(statusText || 'Idle')}</span>`;
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
        const histHtml = allOrig.slice(0, -1)
          .map(t => `<span style="opacity:0.55">${escapeHtml(t)}</span>`).join('<br>');
        const lastHtml = allOrig.length
          ? `<span style="color:#fff;font-weight:600">${escapeHtml(allOrig[allOrig.length-1])}</span>`
          : '';
        transcriptionOriginalEl.innerHTML = `<span style="${TEXT_BLOCK_STYLE}">${histHtml}${histHtml && lastHtml ? '<br>' : ''}${lastHtml}</span>`;
        transcriptionOriginalEl.scrollTop = transcriptionOriginalEl.scrollHeight;
      }

      if (transcriptionTranslatedEl) {
        const allTrans = subtitleTranslatedHistory;
        const histTransHtml = allTrans.slice(0, -1)
          .map(t => `<span style="opacity:0.55;color:#a7f3d0;font-style:italic">${escapeHtml(t)}</span>`).join('<br>');
        const lastTransHtml = allTrans.length
          ? `<span style="color:#a7f3d0;font-style:italic;font-weight:600">${escapeHtml(allTrans[allTrans.length-1])}</span>`
          : '';
          
        transcriptionTranslatedEl.innerHTML = `<span style="${TEXT_BLOCK_STYLE}">${histTransHtml}${histTransHtml && lastTransHtml ? '<br>' : ''}${lastTransHtml}</span>`;
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

    if (transcriptionOriginalEl) {
      transcriptionOriginalEl.innerHTML =
        `<span style="${TEXT_BLOCK_STYLE}">${escapeHtml(originalFormatted)}${livePreviewHtml ? "\n" + livePreviewHtml : ""}</span>`;
    }

    const translatedFull = formatText(normalizeText(translatedChunks.join(" ")), currentFormatting);
    renderBlock(transcriptionTranslatedEl, translatedFull, "color:#a7f3d0;font-style:italic;");

    applyDisplayMode();

    if (transcriptionOriginalEl) transcriptionOriginalEl.scrollTop = transcriptionOriginalEl.scrollHeight;
    if (transcriptionTranslatedEl) transcriptionTranslatedEl.scrollTop = transcriptionTranslatedEl.scrollHeight;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.type) return false;
    
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
        if (request.data.trackLang !== undefined) {
           currentTrackLang = request.data.trackLang;
        }

        const orig = request.data.original;
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
    if ("displayMode" in changes) { currentDisplayMode = changes.displayMode.newValue || "both"; needsRender = true; }
    if ("textFormatting" in changes) { currentFormatting = changes.textFormatting.newValue || "advanced"; needsRender = true; }
    if ("hideLiveText" in changes) { hideLiveText = !!changes.hideLiveText.newValue; needsRender = true; }
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

      if (res.isSubtitleTtsActive) {
         isSubtitleMode = true;
      }

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
