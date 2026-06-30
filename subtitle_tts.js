/*
 * subtitle_tts.js — part of Audio Transcription
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

;(function cleanupPrevious() {
  if (typeof window.__stts_onMsg === 'function')
    try { chrome.runtime.onMessage.removeListener(window.__stts_onMsg); } catch(e){}
  if (typeof window.__stts_onStorage === 'function')
    try { chrome.storage.onChanged.removeListener(window.__stts_onStorage); } catch(e){}
  if (window.__subtitleTtsApi?._cleanup)
    try { window.__subtitleTtsApi._cleanup(); } catch(e){}
  window.__stts_onMsg = window.__stts_onStorage = window.__subtitleTtsApi = null;
})();

window.__subtitleTtsApi = (function () {

  // ── Profile-based accumulation parameters ──────────────────────────────
  // Three modes, mirroring the WhisperLive transcription profile selector:
  //   lowlag      — commit fast; minimal buffering; may cut mid-sentence.
  //   balanced    — wait for punctuation up to a moderate word limit (default).
  //   fullsentence — wait for strong punctuation; max 8 s before hard flush.

  function getProfileCfg(profile) {
    switch (profile) {
      case 'lowlag':
        return {
          MIN_WORDS_PUNCT : 6,
          HARD_COMMIT     : 25,
          MAX_AGE         : 15000,
          MAX_Q           : 6,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 200, 
          T_FALLBACK      : 2000,
          S_OVERFLOW_W    : 20,
          S_OVERFLOW_BACK : 10,
          MIN_FRAG        : 2, 
        };
      case 'fullsentence':
        return {
          MIN_WORDS_PUNCT : 10,
          HARD_COMMIT     : 45,
          MAX_AGE         : 30000,
          MAX_Q           : 3,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 700,
          T_FALLBACK      : 8000,
          S_OVERFLOW_W    : 35,
          S_OVERFLOW_BACK : 25,
          MIN_FRAG        : 6, 
        };
      default: // 'balanced'
        return {
          MIN_WORDS_PUNCT : 8,
          HARD_COMMIT     : 35,
          MAX_AGE         : 30000,
          MAX_Q           : 4,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 400,
          T_FALLBACK      : 4000,
          S_OVERFLOW_W    : 25,
          S_OVERFLOW_BACK : 15,
          MIN_FRAG        : 4, 
        };
    }
  }

  let currentProfile = 'balanced';
  let P = getProfileCfg(currentProfile);  // live profile config

  // Regex for languages without spaces (Chinese, Japanese, etc.)
  const SPACELESS_RE = /[\u3040-\u9FFF\uF900-\uFAFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF]/;
  
  function isSpacelessScript(text) {
    return SPACELESS_RE.test(text);
  }
  function splitWords(text) {
    const t = String(text || '');
    if (isSpacelessScript(t)) {
      return t.replace(/\s+/g, '').split('');
    }
    return t.split(' ').filter(Boolean);
  }
  function joinWords(words) {
    if (!words || !words.length) return '';
    const first = words[0];
    if (SPACELESS_RE.test(first)) {
      return words.join('');
    }
    return words.join(' ');
  }

  let videoEl = null, activeTrack = null, obs = null, activeSel = null, observedNode = null;
  let isSpeaking = false, isTtsSpeaking = false;
  let cueQueue = [], recentTrans = [];
  let ttsId = null, stopped = false;
  let isTextTrackMode = false;
  
  let pendingWords   = [];
  let committedWords = [];
  let lastSeenText   = '';
  let debTimer       = null;
  let silenceTimer   = null; // Independent safety net timer for long pauses
  let isProgressiveMode = false;

  let isSeeking = false;
  let seekCooldownTimer = null;

  function clearContentHistory() {
    try { chrome.runtime.sendMessage({ action: 'clearSubtitleHistory' }); } catch(e){}
  }

  function onSeeked() {
    isSeeking = true;
    cueQueue = [];
    recentTrans = [];
    isSpeaking = false;
    isTtsSpeaking = false;
    pendingWords = [];
    committedWords = [];
    lastSeenText = '';
    clearTimeout(debTimer);
    clearTimeout(silenceTimer);
    clearTimeout(ttsId);

    try { 
      chrome.runtime.sendMessage({ action: 'stopTts', isSeek: true }, () => void chrome.runtime.lastError); 
    } catch(e){}

    // Clear history ONLY on manual seek to prevent hallucinations.
    // We do NOT clear history when an ad starts/ends, ensuring context is kept.
    clearContentHistory(); 

    clearTimeout(seekCooldownTimer);
    seekCooldownTimer = setTimeout(() => { isSeeking = false; }, 400);
  }

  let cfg = {
    playbackControl: 'pause', slowdownRate: 0.8,
    enableGeminiTranslation: false, enableTts: false,
    targetLanguage: 'en', ttsSpeed: 1.0, trackLang: '', sttsSelectedLanguage: '',
    hideNativeSubtitles: true, videoVolume: 1.0
  };

  const originalVideoVolumes = new Map();
  const SKIP = /auto.?generat|generad|généré|automatisch|gerado|generati|автоматически|automatically|inaccurat|turn off subtitle|desactivar|désactiver|keyboard shortcut|atajos|^\[[\p{L}\s]+\]$/iu;

  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

  // Removes common YouTube UI artifacts (screen reader text) and cleans HTML
  function cleanSubtitle(t) {
    let str = String(t || '');
    
    // Aggressively remove hidden screen-reader text injected by YouTube in multiple languages
    const uiArtifacts = [
        /[^\(\)]+\s*\((?:auto-generated|generados automáticamente|généré automatiquement|automatisch|gerado automaticamente|generati automaticamente|автоматически|自動生成|자동 생성|自动生成)[^\)]*\)/gi,
        /(?:haz clic|click|cliquez|klicken|fare clic|clique).*?(?:configuración|settings|paramètres|einstellungen|impostazioni|configurações)/gi,
        /(?:turn off subtitles|desactivar subtítulos|désactiver les sous-titres|untertitel deaktivieren|desativar legendas|disattiva sottotitoli)/gi,
        /(?:keyboard shortcuts|atajos de teclado|raccourcis clavier|tastaturkürzel|atalhos de teclado|scorciatoie da tastiera)/gi
    ];
    uiArtifacts.forEach(rx => { str = str.replace(rx, ' '); });

    return norm(
      str.replace(/<[^>]+>/g, '')    
         .replace(/>+/g, '')         
         .replace(/^\s*-\s+/gm, '')  
         .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
         .replace(/\n/g, ' ')
         .replace(/([.!?¿¡,;:\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965])([^\s\d"'\])}»\u201D\u2019])/g, '$1 $2')
    );
  }

  function skip(t) { return !t || SKIP.test(t); }

  function nw(w) { return String(w || '').toLowerCase().replace(/[.,!?;:'"…']+$/, ''); }

  function committedPrefixLength(committed, incoming, bypassStaticCheck) {
    const normCom = committed.map(nw);
    const normInc = incoming.map(nw);

    const maxOverlap = Math.min(normCom.length, normInc.length);
    for (let size = maxOverlap; size >= 1; size--) {
      let match = true;
      for (let i = 0; i < size; i++) {
        if (normCom[normCom.length - size + i] !== normInc[i]) { match = false; break; }
      }
      if (match) {
        const isStaticStream = !bypassStaticCheck && (isTextTrackMode || !isProgressiveMode);
        if (isStaticStream && size < 3 && size < normInc.length) {
          continue;
        }
        return size;
      }
    }

    for (let size = maxOverlap; size >= 1; size--) {
      const suffix = normCom.slice(normCom.length - size);
      for (let i = 0; i <= normInc.length - size; i++) {
        let match = true;
        for (let k = 0; k < size; k++) {
          if (suffix[k] !== normInc[i + k]) { match = false; break; }
        }
        if (match && (size >= 8 || size === normCom.length)) {
          return i + size;
        }
      }
    }

    return 0;
  }

  function mergeCues(pending, incoming) {
    if (!pending.length) return incoming;
    if (!incoming.length) return pending;
    
    const normP = pending.map(nw);
    const normI = incoming.map(nw);

    if (incoming.length <= pending.length) {
      let isPrefix = true;
      for (let i = 0; i < incoming.length; i++) {
        if (normI[i] !== normP[i]) { isPrefix = false; break; }
      }
      if (isPrefix) return pending.slice(0, incoming.length);
    }

    const maxOverlap = Math.min(normP.length, normI.length);
    for (let size = maxOverlap; size >= 1; size--) {
      let match = true;
      for (let i = 0; i < size; i++) {
        if (normP[normP.length - size + i] !== normI[i]) {
          if (size >= 2 && i === size - 1) continue;
          if (size === 1 && i === 0) {
            const wp = normP[normP.length - 1];
            const wi = normI[0];
            if (wp.startsWith(wi) || wi.startsWith(wp)) continue;
          }
          match = false; break;
        }
      }
      if (match) return [...pending.slice(0, pending.length - size), ...incoming];
    }
    return [...pending, ...incoming];
  }

  // Detects if a native Ad is currently playing on screen
  function isAdPlaying() {
    if (window.location.hostname.includes('youtube.com')) {
      return !!document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay');
    }
    if (window.location.hostname.includes('twitch.tv')) {
      return !!document.querySelector('[data-test-selector="sad-overlay"]');
    }
    return false;
  }

  function findVideo() {
    const all = Array.from(document.querySelectorAll('video'));
    return all.reduce((b, v) => (!b || v.offsetWidth * v.offsetHeight > b.offsetWidth * b.offsetHeight) ? v : b, null);
  }

  function findTrack(v) {
    if (!v) return null;
    const ts = Array.from(v.textTracks);
    if (!ts.length) return null;
    
    // Prefer actively showing tracks
    let activeTrack = ts.find(t => t.mode === 'showing');
    if (activeTrack) return activeTrack;
    
    // Fallback to hidden tracks explicitly marked as subtitles/captions
    let hiddenTrack = ts.find(t => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'hidden');
    if (hiddenTrack) return hiddenTrack;

    return null;
  }

  const DOM_SELS = [
    { c: '.ytp-caption-window-container',              t: '.ytp-caption-segment' },
    { c: '.player-captions-container__caption-window', t: '.player-captions-container__caption-line' },
    { c: '.vjs-text-track-display',                   t: '.vjs-text-track-cue' },
    { c: '#captions-overlay',                         t: '#captions-overlay span' },
    { c: '.player-timedtext',                         t: '.player-timedtext-text-container' },
  ];

  // Extracts text from the DOM while actively ignoring screen-reader or hidden elements
  function getDomText() {
    if (!activeSel) return '';
    try {
      const ss = document.querySelectorAll(activeSel.t);
      if (ss.length) {
        return norm(Array.from(ss).map(s => {
          // Ignore the element entirely if it's explicitly a screen reader block
          if (s.closest && s.closest('.ytp-visually-hidden')) return '';
          
          // Clone the node so we can safely remove hidden children without affecting the UI
          const clone = s.cloneNode(true);
          const hiddenElements = clone.querySelectorAll('.ytp-visually-hidden, .cdx-visually-hidden, [style*="clip: rect(0"]');
          hiddenElements.forEach(el => el.remove());
          
          return clone.textContent;
        }).join(' '));
      }
      const cc = document.querySelector(activeSel.c);
      if (cc) {
        const clone = cc.cloneNode(true);
        const hiddenElements = clone.querySelectorAll('.ytp-visually-hidden, .cdx-visually-hidden, [style*="clip: rect(0"]');
        hiddenElements.forEach(el => el.remove());
        return norm(clone.textContent);
      }
    } catch (e) {
      console.warn("[SubtitleTTS] DOM read error:", e);
    }
    return '';
  }

  function findDom() {
    for (const s of DOM_SELS) {
      const container = document.querySelector(s.c);
      // Ensure the container is actually attached to the document
      if (container && document.body.contains(container)) return s;
    }
    return null;
  }

  function accumulateText(rawText) {
    if (stopped || isSeeking || isAdPlaying()) return;

    const clean = cleanSubtitle(rawText || '');

    if (!clean) {
      if (lastSeenText !== '') {
        lastSeenText = '';
        if (pendingWords.length > 0) {
          clearTimeout(debTimer);
          clearTimeout(silenceTimer);
          
          // Safety net: if the screen stays blank for 2500ms, force a hard commit.
          silenceTimer = setTimeout(forceFlushPending, 2500);

          if (isTextTrackMode) {
            // TextTrack cue just ended. It might be a natural boundary or an
            // inter-segment gap. Soft-flush to keep unpunctuated fragments.
            softFlushPending();
          } else {
            // DOM mutation mode: subtitle box briefly disappeared.
            // Wait proportionally so the next segment can join the buffer.
            const gapDelay = pendingWords.length >= P.MIN_WORDS_PUNCT
              ? 1200
              : P.T_FALLBACK;
            debTimer = setTimeout(softFlushPending, gapDelay);
          }
        }
      }
      return;
    }

    const prevText = lastSeenText;
    if (clean === lastSeenText) return;
    lastSeenText = clean;

    clearTimeout(debTimer);
    clearTimeout(silenceTimer);

    const allWords = splitWords(clean);

    if (!isProgressiveMode && prevText) {
      const lastWords = splitWords(prevText);
      const overlap = committedPrefixLength(lastWords, allWords, true);
      const isSubset = lastWords.every((w, i) => nw(w) === nw(allWords[i])) ||
                       allWords.every((w, i) => nw(w) === nw(lastWords[i]));
      if (overlap >= 3 || isSubset) {
        isProgressiveMode = true;
      }
    }

    const skipCommitted = committedPrefixLength(committedWords, allWords, false);
    const fresh = allWords.slice(skipCommitted);

    // ALWAYS use mergeCues. YouTube autogenerated TextTracks can overlap,
    // and mergeCues safely handles both disjointed and overlapping cues.
    pendingWords = mergeCues(pendingWords, fresh);

    evaluateCommit();
  }

  function evaluateCommit() {
    const wc = pendingWords.length;
    if (!wc) return;

    const RE_PUNCT = /[.!?\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    const RE_STRONG   = /[.!?\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    const RE_OPEN_Q   = /^[\u00bf\u00a1]/;

    const lastWord  = pendingWords[wc - 1] || '';
    const hasPunct  = RE_PUNCT.test(lastWord);

    // isStaticMode: the subtitle line we just received already ends with
    // punctuation (i.e. it's a complete, pre-punctuated segment like TextTrack
    // or a static caption box). We do NOT activate it just because some earlier
    // word in the buffer happened to contain punctuation — that caused cascading
    // splits that left tiny 3-word fragments like "This is the".
    const isStaticMode = isTextTrackMode || hasPunct;

    // ── Internal splitting (buffer has > MIN_WORDS_PUNCT) ────────────────────
    let internalSplitIdx = -1;
    for (let i = P.MIN_WORDS_PUNCT - 1; i < wc - 1; i++) {
      if (RE_PUNCT.test(pendingWords[i])) {
        if (wc - 1 - i < P.MIN_FRAG) continue;
        internalSplitIdx = i;
        break;
      }
    }

    if (internalSplitIdx !== -1) {
      const sentence = pendingWords.slice(0, internalSplitIdx + 1);
      pendingWords   = pendingWords.slice(internalSplitIdx + 1);
      const text = joinWords(sentence);
      committedWords = [...committedWords, ...sentence];
      if (committedWords.length > P.MAX_COMMITTED) committedWords = committedWords.slice(-P.MAX_COMMITTED);
      commitText(text);
      clearTimeout(debTimer);
      // Recursively evaluate the remaining fragment
      evaluateCommit();
      return;
    }

    // ── Last-word evaluation ─────────────────────────────────────────────────
    if (isStaticMode) {
      if (hasPunct && wc >= P.MIN_WORDS_PUNCT) {
        forceFlushPending();
      } else if (hasPunct && wc < P.MIN_WORDS_PUNCT) {
        // Short line with punctuation. Give it time to accumulate more text
        // according to the profile's fallback time instead of rushing a commit.
        clearTimeout(debTimer);
        debTimer = setTimeout(softFlushPending, P.T_FALLBACK);
      } else if (wc >= P.S_OVERFLOW_W) {
        let splitIdx = -1;
        for (let i = wc - 2; i >= P.S_OVERFLOW_BACK; i--) {
          if (RE_PUNCT.test(pendingWords[i]) || RE_OPEN_Q.test(pendingWords[i + 1] || '')) {
            if (wc - 1 - i < P.MIN_FRAG) continue;
            splitIdx = i;
            break;
          }
        }
        if (splitIdx !== -1) {
          const sentence = pendingWords.slice(0, splitIdx + 1);
          pendingWords   = pendingWords.slice(splitIdx + 1);
          const text = joinWords(sentence);
          committedWords = [...committedWords, ...sentence];
          if (committedWords.length > P.MAX_COMMITTED) committedWords = committedWords.slice(-P.MAX_COMMITTED);
          commitText(text);
          clearTimeout(debTimer);
          evaluateCommit();
          return;
        } else {
          clearTimeout(debTimer);
        }
      } else {
        clearTimeout(debTimer);
      }
    } else {
      // Progressive / live stream mode — use debounce timers.
      if (hasPunct && wc >= P.MIN_WORDS_PUNCT) {
        clearTimeout(debTimer);
        debTimer = setTimeout(forceFlushPending, P.T_PUNCT);
      } else {
        clearTimeout(debTimer);
        // Soft flush keeps trailing unpunctuated fragments safe in the buffer
        debTimer = setTimeout(softFlushPending, P.T_FALLBACK);
      }
    }

    // ── Hard Commit ──────────────────────────────────────────────────────────
    if (pendingWords.length >= P.HARD_COMMIT) {
      forceFlushPending();
    }
  }

  function softFlushPending() {
    clearTimeout(debTimer);
    if (!pendingWords.length) return;

    const wc = pendingWords.length;
    const RE_PUNCT = /[.!?\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    
    // If the last word has punctuation, it's a complete thought anyway.
    if (RE_PUNCT.test(pendingWords[wc - 1])) {
      if (wc >= P.MIN_WORDS_PUNCT) forceFlushPending();
      return;
    }

    let splitIdx = -1;
    for (let i = wc - 2; i >= 0; i--) {
      if (RE_PUNCT.test(pendingWords[i])) {
        splitIdx = i;
        break;
      }
    }

    if (splitIdx !== -1) {
      if (pendingWords.length - 1 - splitIdx < P.MIN_FRAG) return;
      const sentence = pendingWords.slice(0, splitIdx + 1);
      pendingWords   = pendingWords.slice(splitIdx + 1);
      const text = joinWords(sentence);
      committedWords = [...committedWords, ...sentence];
      if (committedWords.length > P.MAX_COMMITTED) committedWords = committedWords.slice(-P.MAX_COMMITTED);
      commitText(text);
    }
    // If there is no punctuation anywhere, we leave the fragment in pendingWords.
    // It will be completed when the next subtitle segment arrives, or forced out
    // if it eventually reaches HARD_COMMIT.
  }

  function forceFlushPending() {
    clearTimeout(debTimer);
    clearTimeout(silenceTimer);
    if (!pendingWords.length) return;
    const text = joinWords(pendingWords);
    pendingWords = [];
    lastSeenText = '';

    committedWords = [...committedWords, ...splitWords(text)];
    if (committedWords.length > P.MAX_COMMITTED) committedWords = committedWords.slice(-P.MAX_COMMITTED);

    commitText(text);
  }

  function syncVideoSpeed() {
    if (!videoEl || cfg.playbackControl === 'none' || !cfg.enableTts) return;
    
    if (cfg.playbackControl === 'pause') {
      if (cueQueue.length >= 2 && isSpeaking) {
        applyCtrl();
      } else if (cueQueue.length < 2) {
        restoreCtrl();
      }
    } else if (cfg.playbackControl === 'slowdown') {
      const baseR = Math.max(0.1, cfg.slowdownRate);
      const qDepth = Math.max(0, cueQueue.length - 1);
      const dynamicR = Math.max(0.1, baseR - (qDepth * 0.15));
      if (cueQueue.length > 0 && isSpeaking) {
        applyCtrl(dynamicR);
      } else {
        restoreCtrl();
      }
    }
  }

  function onMutation() { if (!stopped) accumulateText(getDomText()); }

  function onCueChange() {
      if (stopped || !activeTrack || isAdPlaying()) return;
      const cues = activeTrack.activeCues;
      if (!cues || !cues.length) { accumulateText(''); return; }
      isTextTrackMode = true;
      const newText = Array.from(cues).map(c => c.text || '').join(' ');
      accumulateText(newText);
  }

  function startObs(sel) {
    activeSel = sel;
    const c = document.querySelector(sel.c);
    if (!c) return false;
    if (obs) obs.disconnect();
    isTextTrackMode = false;
    observedNode = c; 
    obs = new MutationObserver(onMutation);
    obs.observe(c, { childList: true, subtree: true, characterData: true });
    return true;
  }

  function showContent(orig, disp, statusText, currentSrcLang) {
    try {
      chrome.runtime.sendMessage(
        { type: 'subtitle_display', data: { original: orig, translated: disp, statusText: statusText, trackLang: currentSrcLang } },
        () => void chrome.runtime.lastError
      );
    } catch(e) {}
  }

  function applyCtrl(rateOverride) {
    if (!videoEl) return;
    try {
      if (cfg.playbackControl === 'pause') {
        document.querySelectorAll('video').forEach(v => {
          if (v.offsetWidth > 0) { v.dataset.sttsPaused = '1'; v.pause(); }
        });
      } else if (cfg.playbackControl === 'slowdown' && rateOverride !== undefined) {
        document.querySelectorAll('video').forEach(v => {
          if (v.offsetWidth > 0) {
            if (!v.dataset.stts_rate) v.dataset.stts_rate = v.playbackRate || 1;
            v.playbackRate = rateOverride;
          }
        });
      }
    } catch(e) {}
  }

  function restoreCtrl() {
    try {
      document.querySelectorAll('video').forEach(v => {
        if (v.offsetWidth > 0) {
          if (v.dataset.stts_rate) { v.playbackRate = parseFloat(v.dataset.stts_rate) || 1; delete v.dataset.stts_rate; }
          if (v.dataset.sttsPaused) { delete v.dataset.sttsPaused; v.play().catch(() => {}); }
        }
      });
    } catch(e) {}
  }

  function applyVideoVolume(force = false) {
    try {
      document.querySelectorAll('video').forEach(v => {
        if (v.offsetWidth > 0) {
          if (!originalVideoVolumes.has(v)) {
            originalVideoVolumes.set(v, v.volume);
          }
          v.volume = Math.max(0, Math.min(1, cfg.videoVolume));
        }
      });
    } catch(e) {}
  }
  
  function restoreVideoVolume() {
    try {
      document.querySelectorAll('video').forEach(v => {
        if (originalVideoVolumes.has(v)) { v.volume = originalVideoVolumes.get(v); originalVideoVolumes.delete(v); }
      });
    } catch(e) {}
    originalVideoVolumes.clear();
  }

  function speak(text, lang) {
    chrome.runtime.sendMessage(
      { action: 'subtitleSpeak', text: norm(text), lang: lang || '', ttsSpeed: cfg.ttsSpeed },
      () => void chrome.runtime.lastError
    );
  }

  function commitText(text) {
    const t = norm(text);
    if (skip(t)) return;

    cueQueue.push({ text: t, ts: Date.now() });
    syncVideoSpeed();
    if (!isSpeaking) processQueue();
  }

  function onDone() {
    clearTimeout(ttsId);
    ttsId = null; isSpeaking = false; isTtsSpeaking = false;
    syncVideoSpeed();
    if (!stopped) processQueue();
  }

  async function processQueue() {
    if (stopped || isSpeaking || !cueQueue.length) return;
    const now = Date.now();
    while (cueQueue.length && (now - cueQueue[0].ts) > P.MAX_AGE) cueQueue.shift();
    while (cueQueue.length > P.MAX_Q) cueQueue.shift();
    const item = cueQueue.shift();
    if (!item) return;

    isSpeaking = true;
    syncVideoSpeed();

    let currentSrcLang = cfg.sttsSelectedLanguage || cfg.trackLang;

    if (!currentSrcLang && item.text.trim().length >= 3) {
      try {
        const res = await new Promise(resolve => {
           chrome.runtime.sendMessage({ action: 'detectTextLanguage', text: item.text }, resolve);
        });
        if (res && res.language) {
          currentSrcLang = res.language;
          cfg.trackLang = res.language;
          showContent(null, null, undefined, currentSrcLang); 
        }
      } catch(e) {}
    }

    const needsTrans = cfg.enableGeminiTranslation;

    if (needsTrans) {
      showContent(item.text, '', 'Translating...', currentSrcLang);
      const tail = recentTrans.slice(-2).join(' ');
      chrome.runtime.sendMessage({ action: 'processTranslation', text: item.text, shownTail: tail, skipTts: true, sourceLang: currentSrcLang }, (r) => {
        void chrome.runtime.lastError;
        if (stopped) { isSpeaking = false; isTtsSpeaking = false; restoreCtrl(); return; }
        
        const rawData = norm(r?.data || '');
        const cleanTr = rawData.replace(/^\u207A\s*/, '');
        const st = rawData || item.text;
        const lang = cleanTr ? cfg.targetLanguage : (currentSrcLang || '');
        const geminiError = r?.geminiError || '';
        
        let statusMsg = cleanTr ? 'Translation Active' : '';
        if (geminiError) statusMsg = `GT fallback — Gemini: ${geminiError}`;
        else if (!r?.success) statusMsg = `Translation Error: ${r?.error || 'Unknown'}`;

        if (cleanTr) { recentTrans.push(cleanTr); if (recentTrans.length > 10) recentTrans.shift(); }
        
        showContent(item.text, st, statusMsg, currentSrcLang);
        
        if (cfg.enableTts) { isTtsSpeaking = true; ttsId = setTimeout(onDone, 20000); speak(cleanTr || item.text, lang); }
        else setTimeout(onDone, 50);
      });
    } else {
      showContent(item.text, '', '', currentSrcLang);
      if (cfg.enableTts) { isTtsSpeaking = true; ttsId = setTimeout(onDone, 20000); speak(item.text, currentSrcLang || ''); }
      else setTimeout(onDone, 50);
    }
  }

  function resetState() {
    clearTimeout(debTimer); 
    clearTimeout(silenceTimer); 
    clearTimeout(ttsId);
    isSpeaking = false; isTtsSpeaking = false;
    pendingWords = []; committedWords = []; lastSeenText = '';
    cueQueue = []; recentTrans = [];
    debTimer = null; silenceTimer = null; ttsId = null;
    isTextTrackMode = false;
    isProgressiveMode = false;
  }

  // Forces YouTube CC button to stay ON if the extension is running
  function ensureSubtitlesActive() {
    try {
      const ccBtn = document.querySelector('.ytp-subtitles-button');
      if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
        ccBtn.click();
      }
    } catch(e) {}
  }

  async function init(settings) {
    resetState();
    stopped = false;
    if (settings) {
      cfg = { ...cfg, ...settings };
      // Apply profile from settings
      if (settings.subtitleTtsProfile) {
        currentProfile = settings.subtitleTtsProfile;
        P = getProfileCfg(currentProfile);
      }
    }
    videoEl = findVideo();
    if (!videoEl) return { success: false, error: 'no_video' };
    applyVideoVolume(true);

    ensureSubtitlesActive();

    try {
      if (cfg.hideNativeSubtitles !== false && !document.getElementById('stts-hide-cc')) {
        const s = document.createElement('style');
        s.id = 'stts-hide-cc';
        s.textContent = '.ytp-caption-window-container, .caption-window { opacity: 0.01 !important; pointer-events: none !important; }';
        document.head.appendChild(s);
      }
    } catch(e) {}

    // Main observer loop to handle ad swaps and video changes
    const bgSearch = setInterval(() => {
      if (stopped) { clearInterval(bgSearch); return; }
      
      const currentVideo = findVideo();
      if (currentVideo !== videoEl) {
        if (obs) { obs.disconnect(); obs = null; activeSel = null; observedNode = null; }
        if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
        if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); }
        videoEl = currentVideo;
        if (videoEl) { videoEl.addEventListener('seeked', onSeeked); }
        applyVideoVolume(true); 
      } else {
        applyVideoVolume(false); 
      }

      if (!videoEl) return;

      // Ensure YouTube didn't turn off CC after an ad
      ensureSubtitlesActive();

      // Ensure DOM has priority over TextTrack to avoid YouTube dummy ad tracks.
      if (!activeTrack && !obs) {
        const sel = findDom();
        if (sel && startObs(sel)) {
          // Successfully attached to DOM (Visual rendering)
        } else {
          // Fallback to TextTrack if DOM is not applicable
          const t = findTrack(videoEl);
          if (t) {
            activeTrack = t;
            cfg.trackLang = activeTrack.language || '';
            if (activeTrack.mode === 'disabled') activeTrack.mode = 'hidden';
            activeTrack.addEventListener('cuechange', onCueChange);
          }
        }
      } else if (activeTrack) {
        const trackValid = Array.from(videoEl.textTracks).includes(activeTrack);
        if (!trackValid || activeTrack.mode === 'disabled') {
          activeTrack.removeEventListener('cuechange', onCueChange);
          activeTrack = null;
          resetState();
          // NO HISTORY WIPE HERE: Ensures video context persists after an ad ends
        }
      } else if (obs) {
        if (!observedNode || !document.body.contains(observedNode)) {
          obs.disconnect(); obs = null; activeSel = null; observedNode = null;
          resetState();
          // NO HISTORY WIPE HERE: Ensures video context persists after an ad ends
        }
      }
    }, 1000);

    return { success: true };
  }

  function _cleanup() {
    stopped = true;
    if (obs) { obs.disconnect(); obs = null; }
    if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
    if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); }
    const s = document.getElementById('stts-hide-cc');
    if (s) s.remove();
    restoreCtrl(); restoreVideoVolume(); resetState(); activeSel = null; observedNode = null;
  }

  function stop() {
    _cleanup();
    try { chrome.runtime.sendMessage({ action: 'stopTts' }, () => void chrome.runtime.lastError); } catch {}
    try { chrome.runtime.sendMessage({ type: 'STOP' },     () => void chrome.runtime.lastError); } catch {}
  }

  function onMsg(req, sender, res) {
    if (!req?.type) return false;
    switch (req.type) {
      case 'SUBTITLE_TTS_INIT':
        init(req.settings).then(res).catch(e => res({ success: false, error: String(e) }));
        return true;
      case 'SUBTITLE_TTS_DONE': onDone(); return false;
      case 'STOP_SUBTITLE_TTS': stop(); res({ success: true }); return false;
      default: return false;
    }
  }

  function onStorageChange(changes, area) {
    if (area !== 'local') return;
    if (changes.subtitlePlaybackControl)    cfg.playbackControl         = changes.subtitlePlaybackControl.newValue    || 'pause';
    if (changes.subtitleSlowdownRate)       cfg.slowdownRate            = parseFloat(changes.subtitleSlowdownRate.newValue) || 0.8;
    if (changes.enableGeminiTranslation)    cfg.enableGeminiTranslation = !!changes.enableGeminiTranslation.newValue;
    if (changes.targetLanguage)             cfg.targetLanguage          = changes.targetLanguage.newValue || 'en';
    if (changes.sttsSelectedLanguage)       cfg.sttsSelectedLanguage    = changes.sttsSelectedLanguage.newValue || '';
    if (changes.ttsSpeed)                   cfg.ttsSpeed                = parseFloat(changes.ttsSpeed.newValue) || 1.0;
    if (changes.enableTts)                  cfg.enableTts               = !!changes.enableTts.newValue;
    if (changes.subtitleVideoVolume !== undefined) {
      cfg.videoVolume = parseFloat(changes.subtitleVideoVolume.newValue || '1.0');
      if (!stopped) applyVideoVolume(true);
    }
    if (changes.hideNativeSubtitles) {
      cfg.hideNativeSubtitles = changes.hideNativeSubtitles.newValue !== false;
      const existing = document.getElementById('stts-hide-cc');
      if (cfg.hideNativeSubtitles && !existing) {
        const s = document.createElement('style');
        s.id = 'stts-hide-cc';
        s.textContent = '.ytp-caption-window-container, .caption-window { opacity: 0.01 !important; pointer-events: none !important; }';
        document.head.appendChild(s);
      } else if (!cfg.hideNativeSubtitles && existing) { existing.remove(); }
    }
    if (changes.subtitleTtsProfile) {
      currentProfile = changes.subtitleTtsProfile.newValue || 'balanced';
      P = getProfileCfg(currentProfile);
    }
  }

  chrome.runtime.onMessage.addListener(onMsg);
  chrome.storage.onChanged.addListener(onStorageChange);
  window.__stts_onMsg     = onMsg;
  window.__stts_onStorage = onStorageChange;

  return { reinit: (s) => init(s), stop, _cleanup };
})();
