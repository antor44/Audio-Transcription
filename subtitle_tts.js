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

  // ── Profile-based accumulation parameters (exact v3.2.0 values) ───────────
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
  let P = getProfileCfg(currentProfile);

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
  let bgSearch = null;
  
  let pendingWords   = [];
  let committedWords = [];
  let lastSeenText   = '';
  let debTimer       = null;
  let silenceTimer   = null;
  let isProgressiveMode = false;

  let isSeeking = false;
  let seekCooldownTimer = null;
  let _bmpSubtitleAttempted = false;

  // ── Exact onSeeked from v3.2.0 (does not wipe history on seek) ────────────
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

  // Pattern matching standalone UI artifacts, keyboard shortcuts, or language toast banners
  const SKIP = /auto.?generat|generad|généré|automatisch|gerado|generati|автоматически|automatically|inaccurat|turn off subtitle|desactivar|désactiver|keyboard shortcut|atajos|^\[[\p{L}\s]+\]$|^(?:[A-Za-zÀ-ÿ\s]+)\s*\([^\)]+\)$/iu;

  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

  // ── Exact cleanSubtitle from v3.2.0 with language tag removal ────────────
  function cleanSubtitle(t) {
    let str = String(t || '');
    
    // Aggressively remove YouTube language banners and UI artifacts
    const uiArtifacts = [
      /[^\(\)]+\s*\((?:auto-generated|generados automáticamente|generado automáticamente|généré automáticamente|automatisch|gerado automaticamente|generati automáticamente|автоматически|自動生成|자동 생성|自动生成|Estados Unidos|United States|Reino Unido|United Kingdom|España|Spain|México|Mexico)[^\)]*\)/gi,
      /(?:haz clic|click|cliquez|klicken|fare clic|clique).*?(?:configuración|settings|paramètres|einstellungen|impostazioni|configurações)/gi,
      /(?:turn off subtitles|desactivar subtítulos|désactiver les sous-titres|untertitel deaktivieren|desativar legendas|disattiva sottotitoli)/gi,
      /(?:keyboard shortcuts|atajos de teclado|raccourcis clavier|tastaturkürzel|atalhos de teclado|scorciatoie da tastiera)/gi
    ];
    uiArtifacts.forEach(rx => { str = str.replace(rx, ' '); });

    // WebVTT timestamp formatting
    str = str.replace(/\d{2}:\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[\.,]\d{3}/g, ' ');
    str = str.replace(/align:[a-z]+|size:\d+%|position:\d+%/gi, ' ');

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

  // ── Exact committedPrefixLength from v3.2.0 ───────────────────────────────
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

  // ── Exact mergeCues from v3.2.0 ───────────────────────────────────────────
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

  // ── Exact isAdPlaying from v3.2.0 (with scope extensions) ─────────────────
  function isAdPlaying() {
    if (window.location.hostname.includes('youtube.com')) {
      return !!document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay');
    }
    if (window.location.hostname.includes('twitch.tv')) {
      return !!document.querySelector('[data-test-selector="sad-overlay"]');
    }
    const scope = getPlayerScope(videoEl);
    if (scope && (scope.classList.contains('vjs-ad-playing') || scope.classList.contains('ad-showing') || scope.querySelector('.bmpui-ui-ad-overlay'))) {
      return true;
    }
    return false;
  }

  function findAllMedia(root = document) {
    let media = [];
    try {
      media.push(...Array.from(root.querySelectorAll('video')));
    } catch(e) {}
    try {
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) media.push(...findAllMedia(el.shadowRoot));
      }
    } catch(e) {}
    try {
      for (const iframe of root.querySelectorAll('iframe')) {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) media.push(...findAllMedia(doc));
      }
    } catch(e) {}
    return media;
  }

  function findVideo() {
    const all = findAllMedia(document);
    return all.reduce((b, v) => (!b || v.offsetWidth * v.offsetHeight > b.offsetWidth * b.offsetHeight) ? v : b, null);
  }

  function findTrack(v) {
    if (!v) return null;
    const ts = Array.from(v.textTracks || []);
    if (!ts.length) return null;
    
    let track = ts.find(t => t.mode === 'showing');
    if (track) return track;
    
    if (cfg.sttsSelectedLanguage && cfg.sttsSelectedLanguage.toUpperCase() !== 'AUTO') {
      const pref = cfg.sttsSelectedLanguage.toLowerCase();
      track = ts.find(t => (t.language || '').toLowerCase().startsWith(pref));
      if (track) return track;
    }

    let hiddenTrack = ts.find(t => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'hidden');
    if (hiddenTrack) return hiddenTrack;

    return null;
  }

  function getPlayerScope(v) {
    if (!v) return null;
    try {
      return v.closest(
        '.video-js, .jwplayer, .plyr, .bmpui-ui-uicontainer, ' +
        '[class*="player-wrapper" i], [class*="player-container" i]'
      ) || null;
    } catch (e) { return null; }
  }

  // ── Scoped DOM selectors matching dedicated subtitle containers ──────────
  const DOM_SELS = [
    // YouTube
    { c: '.ytp-caption-window-container',                               t: '.ytp-caption-segment' },
    // Twitch
    { c: '.player-captions-container__caption-window',                  t: '.player-captions-container__caption-line' },
    // Deutsche Welle & Video.js: ONLY .vjs-text-track-cue
    { c: '.vjs-text-track-display',                                     t: '.vjs-text-track-cue' },
    // 3Cat & Bitmovin: ONLY .bmpui-ui-subtitle-label
    { c: '.bmpui-ui-subtitle-overlay, .bmpui-subtitle-region-container', t: '.bmpui-ui-subtitle-label' },
    // JW Player
    { c: '.jw-captions, .jw-text-track-display',                        t: '.jw-text-track-cue' },
    // Plyr
    { c: '.plyr__captions',                                            t: '.plyr__caption' },
    // Shaka
    { c: '.shaka-text-container',                                      t: '.shaka-text-wrapper' },
    // MediaElement
    { c: '.mejs__captions-layer',                                      t: '.mejs__captions-text' },
    // Others
    { c: '.able-captions-wrapper',                                      t: '.able-captions' },
    { c: '.fp-captions',                                               t: 'p' },
    { c: '.dmp_subtitles',                                             t: '.dmp_subtitle_line' },
    { c: '#captions-overlay',                                          t: '#captions-overlay span' },
    { c: '.player-timedtext',                                          t: '.player-timedtext-text-container' },
  ];

  // ── Exact getDomText from v3.2.0 (with scoped container & top banner filter) ─
  function getDomText() {
    if (!activeSel) return '';
    try {
      const scope = activeSel.root || getPlayerScope(videoEl) || document;
      const container = scope.querySelector(activeSel.c);
      if (!container) return '';

      const PURGE = '.ytp-visually-hidden, .cdx-visually-hidden, .ytp-caption-window-header, .ytp-caption-window-rollup, [style*="clip: rect(0"]';

      if (activeSel.t) {
        const ss = container.querySelectorAll(activeSel.t);
        if (ss.length) {
          const parts = [];
          for (const s of ss) {
            // Ignore YouTube's top notification window and screen reader elements
            if (s.closest && (
              s.closest('.ytp-caption-window-top') ||
              s.closest('.ytp-bezel') ||
              s.closest('.ytp-visually-hidden') ||
              s.closest('.ytp-caption-window-header')
            )) continue;

            const clone = s.cloneNode(true);
            const hidden = clone.querySelectorAll(PURGE);
            hidden.forEach(el => el.remove());
            const txt = norm(clone.textContent);
            if (txt && !SKIP.test(txt)) {
              parts.push(txt);
            }
          }
          if (parts.length) return norm(parts.join(' '));
        }
      }

      // Container fallback
      const clone = container.cloneNode(true);
      const hidden = clone.querySelectorAll('.ytp-caption-window-top, ' + PURGE);
      hidden.forEach(el => el.remove());
      const res = norm(clone.textContent);
      return SKIP.test(res) ? '' : res;
    } catch (e) {}
    return '';
  }

  function findDom() {
    const scope = getPlayerScope(videoEl);
    if (scope) {
      for (const s of DOM_SELS) {
        try {
          const container = scope.querySelector(s.c);
          if (container && document.body.contains(container)) return { ...s, root: scope };
        } catch (e) {}
      }
    }
    for (const s of DOM_SELS) {
      const container = document.querySelector(s.c);
      if (container && document.body.contains(container)) return { ...s, root: document };
    }
    return null;
  }

  // ── Exact accumulateText from v3.2.0 ─────────────────────────────────────
  function accumulateText(rawText) {
    if (stopped || isSeeking || isAdPlaying()) return;

    const clean = cleanSubtitle(rawText || '');

    if (!clean) {
      if (lastSeenText !== '') {
        lastSeenText = '';
        if (pendingWords.length > 0) {
          clearTimeout(debTimer);
          clearTimeout(silenceTimer);
          
          silenceTimer = setTimeout(forceFlushPending, 2500);

          if (isTextTrackMode) {
            softFlushPending();
          } else {
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

    pendingWords = mergeCues(pendingWords, fresh);

    evaluateCommit();
  }

  // ── Exact evaluateCommit from v3.2.0 (with colon support for DW German) ───
  function evaluateCommit() {
    const wc = pendingWords.length;
    if (!wc) return;

    const RE_PUNCT = /[.!?:\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    const RE_OPEN_Q   = /^[\u00bf\u00a1]/;

    const lastWord  = pendingWords[wc - 1] || '';
    const hasPunct  = RE_PUNCT.test(lastWord);

    const isStaticMode = isTextTrackMode || hasPunct;

    // Internal splitting
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
      evaluateCommit();
      return;
    }

    // Last-word evaluation
    if (isStaticMode) {
      if (hasPunct && wc >= P.MIN_WORDS_PUNCT) {
        forceFlushPending();
      } else if (hasPunct && wc < P.MIN_WORDS_PUNCT) {
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
      // Progressive / rolling caption mode
      if (hasPunct && wc >= P.MIN_WORDS_PUNCT) {
        clearTimeout(debTimer);
        debTimer = setTimeout(forceFlushPending, P.T_PUNCT);
      } else {
        clearTimeout(debTimer);
        debTimer = setTimeout(softFlushPending, P.T_FALLBACK);
      }
    }

    if (pendingWords.length >= P.HARD_COMMIT) {
      forceFlushPending();
    }
  }

  // ── Exact softFlushPending from v3.2.0 (preserves unpunctuated text) ───────
  function softFlushPending() {
    clearTimeout(debTimer);
    if (!pendingWords.length) return;

    const wc = pendingWords.length;
    const RE_PUNCT = /[.!?:\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    
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
  }

  // ── Exact forceFlushPending from v3.2.0 ──────────────────────────────────
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

  // Purely mutation-driven: only runs on actual DOM character/child mutations
  function onMutation() { 
    if (!stopped) {
      accumulateText(getDomText()); 
    }
  }

  function onCueChange() {
    if (stopped || !activeTrack || isAdPlaying()) return;
    const cues = activeTrack.activeCues;
    if (!cues || !cues.length) { 
      accumulateText(''); 
      return; 
    }
    isTextTrackMode = true;
    const newText = Array.from(cues).map(c => c.text || '').join(' ');
    accumulateText(newText);
  }

  // Purely event-driven startObs from v3.2.0 (no eager synchronous DOM reads)
  function startObs(sel) {
    activeSel = sel;
    const scope = sel.root || getPlayerScope(videoEl) || document;
    const c = scope.querySelector(sel.c);
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
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(
          { type: 'subtitle_display', data: { original: orig, translated: disp, statusText: statusText, trackLang: currentSrcLang } },
          () => void chrome.runtime.lastError
        );
      }
    } catch(e) {}
  }

  function applyCtrl(rateOverride) {
    if (!videoEl) return;
    try {
      const all = findAllMedia(document);
      if (cfg.playbackControl === 'pause') {
        all.forEach(v => {
          v.dataset.sttsPaused = '1';
          v.pause();
        });
      } else if (cfg.playbackControl === 'slowdown' && rateOverride !== undefined) {
        all.forEach(v => {
          if (!v.dataset.stts_rate) v.dataset.stts_rate = v.playbackRate || 1;
          v.playbackRate = rateOverride;
        });
      }
    } catch(e) {}
  }

  function restoreCtrl() {
    try {
      findAllMedia(document).forEach(v => {
        if (v.dataset.stts_rate) {
          v.playbackRate = parseFloat(v.dataset.stts_rate) || 1;
          delete v.dataset.stts_rate;
        }
        if (v.dataset.sttsPaused) {
          delete v.dataset.sttsPaused;
          v.play().catch(() => {});
        }
      });
    } catch(e) {}
  }

  function applyVideoVolume(force = false) {
    try {
      findAllMedia(document).forEach(v => {
        if (!originalVideoVolumes.has(v)) {
          originalVideoVolumes.set(v, v.volume);
        }
        v.volume = Math.max(0, Math.min(1, cfg.videoVolume));
      });
    } catch(e) {}
  }
  
  function restoreVideoVolume() {
    try {
      findAllMedia(document).forEach(v => {
        if (originalVideoVolumes.has(v)) {
          v.volume = originalVideoVolumes.get(v);
          originalVideoVolumes.delete(v);
        }
      });
    } catch(e) {}
    originalVideoVolumes.clear();
  }

  function speak(text, lang) {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(
      { action: 'subtitleSpeak', text: norm(text), lang: lang || '', ttsSpeed: cfg.ttsSpeed },
      () => void chrome.runtime.lastError
    );
  }

  // ── Exact commitText from v3.2.0 ─────────────────────────────────────────
  function commitText(text) {
    const t = norm(text);
    if (skip(t)) return;

    cueQueue.push({ text: t, ts: Date.now() });
    syncVideoSpeed();
    if (!isSpeaking) processQueue();
  }

  // ── Exact onDone from v3.2.0 ─────────────────────────────────────────────
  function onDone() {
    clearTimeout(ttsId);
    ttsId = null;
    isSpeaking = false;
    isTtsSpeaking = false;
    syncVideoSpeed();
    if (!stopped) processQueue();
  }

  // ── Exact processQueue from v3.2.0 ───────────────────────────────────────
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

    if (!currentSrcLang && item.text.trim().length >= 3 && chrome.runtime?.id) {
      try {
        const res = await Promise.race([
          new Promise(resolve => chrome.runtime.sendMessage({ action: 'detectTextLanguage', text: item.text }, resolve)),
          new Promise(resolve => setTimeout(() => resolve(null), 1000))
        ]);
        if (res && res.language && res.language !== 'und') {
          detectedLang = res.language.toLowerCase().split('-')[0];
          currentSrcLang = detectedLang;
          cfg.trackLang = detectedLang;
          showContent(null, null, undefined, currentSrcLang); 
        }
      } catch(e) {}
    }

    const needsTrans = cfg.enableGeminiTranslation;

    if (needsTrans) {
      showContent(item.text, '', 'Translating...', currentSrcLang);
      const tail = recentTrans.slice(-2).join(' ');
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(
          { action: 'processTranslation', text: item.text, shownTail: tail, skipTts: true, sourceLang: currentSrcLang },
          (r) => {
            void chrome.runtime.lastError;
            if (stopped) {
              isSpeaking = false;
              isTtsSpeaking = false;
              restoreCtrl();
              return;
            }
            
            const rawData = norm(r?.data || '');
            const cleanTr = rawData.replace(/^\u207A\s*/, '');
            const st = rawData || item.text;
            const lang = cleanTr ? cfg.targetLanguage : (currentSrcLang || '');
            const geminiError = r?.geminiError || '';
            
            if (!cleanTr && !rawData) {
              setTimeout(onDone, 50);
              return;
            }

            let statusMsg = cleanTr ? 'Translation Active' : '';
            if (geminiError) statusMsg = `GT fallback — Gemini: ${geminiError}`;
            else if (!r?.success) statusMsg = `Translation Error: ${r?.error || 'Unknown'}`;

            if (cleanTr) {
              recentTrans.push(cleanTr);
              if (recentTrans.length > 10) recentTrans.shift();
            }
            
            showContent(item.text, st, statusMsg, currentSrcLang);
            
            if (cfg.enableTts) {
              isTtsSpeaking = true;
              ttsId = setTimeout(onDone, 20000);
              speak(cleanTr || item.text, lang);
            } else {
              setTimeout(onDone, 50);
            }
          }
        );
      }
    } else {
      showContent(item.text, '', '', currentSrcLang);
      if (cfg.enableTts) {
        isTtsSpeaking = true;
        ttsId = setTimeout(onDone, 20000);
        speak(item.text, currentSrcLang || '');
      } else {
        setTimeout(onDone, 50);
      }
    }
  }

  function resetState() {
    clearTimeout(debTimer); 
    clearTimeout(silenceTimer); 
    clearTimeout(ttsId);
    isSpeaking = false;
    isTtsSpeaking = false;
    pendingWords = [];
    committedWords = [];
    lastSeenText = '';
    cueQueue = [];
    recentTrans = [];
    debTimer = null;
    silenceTimer = null;
    ttsId = null;
    isTextTrackMode = false;
    isProgressiveMode = false;
    cfg.trackLang = '';
    detectedLang = '';
  }

  // ── Exact ensureSubtitlesActive from v3.2.0 (with 3Cat & DW UI clicks only)
  function ensureSubtitlesActive() {
    try {
      const ytCc = document.querySelector('.ytp-subtitles-button');
      if (ytCc && ytCc.getAttribute('aria-pressed') === 'false') {
        ytCc.click();
      }

      const twitchCc = document.querySelector('[data-a-target="player-subtitles-button"]');
      if (twitchCc && twitchCc.getAttribute('aria-checked') === 'false') {
        twitchCc.click();
      }

      if (!_bmpSubtitleAttempted && !lastSeenText) {
        const bmpCc = document.querySelector('.bmpui-ui-subtitlesettingstogglebutton.bmpui-off');
        if (bmpCc) { bmpCc.click(); _bmpSubtitleAttempted = true; }
      }

      const vjsScope = getPlayerScope(videoEl) || document;
      const vjsMenuItems = vjsScope.querySelectorAll(
        '.vjs-subs-caps-button .vjs-menu-item, ' +
        '.vjs-subtitles-button .vjs-menu-item, ' +
        '.vjs-captions-button .vjs-menu-item'
      );
      for (const item of vjsMenuItems) {
        const txt = (item.textContent || '').toLowerCase().trim();
        const isOff = /off|desactiv|deaktiv|none|disabled/i.test(txt);
        const isSettings = /setting|configura|einstellung/i.test(txt);
        const isSelected = item.classList.contains('vjs-selected') || item.getAttribute('aria-checked') === 'true';
        if (!isOff && !isSettings && !isSelected) {
          item.click();
          break;
        }
      }
    } catch(e) {}
  }

  function updateHideNativeSubtitlesStyle() {
    try {
      const existing = document.getElementById('stts-hide-cc');
      if (cfg.hideNativeSubtitles !== false) {
        if (!existing) {
          const s = document.createElement('style');
          s.id = 'stts-hide-cc';
          s.textContent = `
            .ytp-caption-window-container, .caption-window,
            .bmpui-ui-subtitle-overlay, .bmpui-subtitle-region-container,
            .jw-captions, .jw-text-track-display,
            .vjs-text-track-display, .plyr__captions,
            .shaka-text-container, .player-captions-container__caption-window,
            .player-timedtext, .dmp_subtitles, .mejs__captions-layer {
              opacity: 0.01 !important;
              pointer-events: none !important;
            }
          `;
          document.head.appendChild(s);
        }
      } else if (existing) {
        existing.remove();
      }
    } catch(e) {}
  }

  // ── Exact attachSubtitles from v3.2.0 (DOM takes priority, fallback to track)
  function attachSubtitles() {
    if (!videoEl || stopped) return;

    if (!activeTrack && !obs) {
      const sel = findDom();
      if (sel && startObs(sel)) {
        // Successfully attached to DOM
      } else {
        const t = findTrack(videoEl);
        if (t) {
          activeTrack = t;
          cfg.trackLang = activeTrack.language || '';
          if (activeTrack.mode === 'disabled') activeTrack.mode = 'hidden';
          activeTrack.addEventListener('cuechange', onCueChange);
        }
      }
    } else if (activeTrack) {
      const trackValid = Array.from(videoEl.textTracks || []).includes(activeTrack);
      if (!trackValid || activeTrack.mode === 'disabled') {
        activeTrack.removeEventListener('cuechange', onCueChange);
        activeTrack = null;
        resetState();
      }
    } else if (obs) {
      if (!observedNode || !document.body.contains(observedNode)) {
        obs.disconnect(); obs = null; activeSel = null; observedNode = null;
        resetState();
      }
    }
  }

  // ── Exact init and observer loop from v3.2.0 ─────────────────────────────
  async function init(settings) {
    resetState();
    stopped = false;

    if (settings) {
      cfg = { ...cfg, ...settings };
      if (settings.subtitleTtsProfile) {
        currentProfile = settings.subtitleTtsProfile;
        P = getProfileCfg(currentProfile);
      }
      if (settings.sttsSelectedLanguage) {
        cfg.sttsSelectedLanguage = (settings.sttsSelectedLanguage.toUpperCase() === 'AUTO') ? '' : settings.sttsSelectedLanguage;
      }
    }

    videoEl = findVideo();
    if (!videoEl) return { success: false, error: 'no_video' };

    applyVideoVolume(true);
    ensureSubtitlesActive();
    videoEl.addEventListener('seeked', onSeeked);
    updateHideNativeSubtitlesStyle();

    bgSearch = setInterval(() => {
      if (stopped || !chrome.runtime?.id) { 
        clearInterval(bgSearch); 
        bgSearch = null; 
        return; 
      }
      
      const currentVideo = findVideo();
      if (currentVideo && currentVideo !== videoEl) {
        if (obs) { obs.disconnect(); obs = null; activeSel = null; observedNode = null; }
        if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
        if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); }
        videoEl = currentVideo;
        if (videoEl) { videoEl.addEventListener('seeked', onSeeked); }
        applyVideoVolume(true);
        resetState();
      } else {
        applyVideoVolume(false);
      }

      if (!videoEl) return;
      ensureSubtitlesActive();
      attachSubtitles();
    }, 1000);

    return { success: true };
  }

  function _cleanup() {
    stopped = true;
    if (bgSearch) { clearInterval(bgSearch); bgSearch = null; }
    if (obs) { obs.disconnect(); obs = null; }
    if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
    if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); videoEl = null; }
    const s = document.getElementById('stts-hide-cc');
    if (s) s.remove();
    restoreCtrl();
    restoreVideoVolume();
    resetState();
    activeSel = null;
    observedNode = null;
  }

  function stop() {
    _cleanup();
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ action: 'stopTts' }, () => void chrome.runtime.lastError);
      }
    } catch {}
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ type: 'STOP' }, () => void chrome.runtime.lastError);
      }
    } catch {}
  }

  function onMsg(req, sender, res) {
    if (!req?.type) return false;
    switch (req.type) {
      case 'SUBTITLE_TTS_INIT':
        init(req.settings).then(res).catch(e => res({ success: false, error: String(e) }));
        return true;
      case 'SUBTITLE_TTS_DONE':
        onDone();
        return false;
      case 'STOP_SUBTITLE_TTS':
        stop();
        res({ success: true });
        return false;
      default:
        return false;
    }
  }

  function onStorageChange(changes, area) {
    if (area !== 'local') return;
    if (changes.subtitlePlaybackControl)    cfg.playbackControl         = changes.subtitlePlaybackControl.newValue    || 'pause';
    if (changes.subtitleSlowdownRate)       cfg.slowdownRate            = parseFloat(changes.subtitleSlowdownRate.newValue) || 0.8;
    if (changes.enableGeminiTranslation)    cfg.enableGeminiTranslation = !!changes.enableGeminiTranslation.newValue;
    if (changes.targetLanguage)             cfg.targetLanguage          = changes.targetLanguage.newValue || 'en';
    if (changes.sttsSelectedLanguage) {
      const newVal = changes.sttsSelectedLanguage.newValue || '';
      cfg.sttsSelectedLanguage = (newVal.toUpperCase() === 'AUTO') ? '' : newVal;
      if (!cfg.sttsSelectedLanguage) {
        cfg.trackLang = '';
        detectedLang = '';
        if (videoEl) {
          const t = findTrack(videoEl);
          if (t && t.language && t.language !== 'und') {
            cfg.trackLang = t.language.toLowerCase().split('-')[0];
          }
        }
      }
    }
    if (changes.ttsSpeed)                   cfg.ttsSpeed                = parseFloat(changes.ttsSpeed.newValue) || 1.0;
    if (changes.enableTts)                  cfg.enableTts               = !!changes.enableTts.newValue;
    if (changes.subtitleVideoVolume !== undefined) {
      cfg.videoVolume = parseFloat(changes.subtitleVideoVolume.newValue || '1.0');
      if (!stopped) applyVideoVolume(true);
    }
    if (changes.hideNativeSubtitles) {
      cfg.hideNativeSubtitles = changes.hideNativeSubtitles.newValue !== false;
      updateHideNativeSubtitlesStyle();
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
