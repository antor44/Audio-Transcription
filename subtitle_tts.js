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
  function getProfileCfg(profile) {
    switch (profile) {
      case 'lowlag':
        return {
          MIN_WORDS_PUNCT : 4,
          HARD_COMMIT     : 25,
          MAX_AGE         : 15000,
          MAX_Q           : 6,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 150, 
          T_FALLBACK      : 1500,
          S_OVERFLOW_W    : 18,
          S_OVERFLOW_BACK : 10,
          MIN_FRAG        : 2, 
        };
      case 'fullsentence':
        return {
          MIN_WORDS_PUNCT : 8,
          HARD_COMMIT     : 45,
          MAX_AGE         : 30000,
          MAX_Q           : 3,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 600,
          T_FALLBACK      : 5000,
          S_OVERFLOW_W    : 35,
          S_OVERFLOW_BACK : 25,
          MIN_FRAG        : 5, 
        };
      default: // 'balanced'
        return {
          MIN_WORDS_PUNCT : 5,
          HARD_COMMIT     : 35,
          MAX_AGE         : 30000,
          MAX_Q           : 4,
          MAX_COMMITTED   : 500,
          T_PUNCT         : 250,
          T_FALLBACK      : 2500,
          S_OVERFLOW_W    : 22,
          S_OVERFLOW_BACK : 14,
          MIN_FRAG        : 3, 
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
  let domPollTimer = null;
  let detectedLang = '';
  
  let pendingWords   = [];
  let committedWords = [];
  let lastSeenText   = '';
  let debTimer       = null;
  let silenceTimer   = null;
  // YouTube and Twitch use progressive rolling captions right from second 0
  let isProgressiveMode = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('twitch.tv');

  let isSeeking = false;
  let seekCooldownTimer = null;
  let lastRecordedTime = null;
  let currentSessionEpoch = 0;
  let localUtteranceCounter = 0;
  let currentActiveUtteranceId = 0;
  let recentCommittedTexts = [];
  let _bmpSubtitleAttempted = false;

  function clearContentHistory() {
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ action: 'clearSubtitleHistory' }, () => void chrome.runtime.lastError);
      }
    } catch(e){}
  }

  function onSeeking() {
    if (stopped) return;
    isSeeking = true;
    currentSessionEpoch++;
    cueQueue = [];
    recentTrans = [];
    pendingWords = [];
    committedWords = [];
    lastSeenText = '';
    recentCommittedTexts = [];
    clearTimeout(debTimer);
    clearTimeout(silenceTimer);
    clearTimeout(ttsId);
    isSpeaking = false;
    isTtsSpeaking = false;
    currentActiveUtteranceId = 0;

    try { 
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ action: 'stopTts', isSeek: true }, () => void chrome.runtime.lastError); 
      }
    } catch(e){}

    clearContentHistory();
  }

  function onSeeked() {
    if (stopped) return;
    onSeeking();
    clearTimeout(seekCooldownTimer);
    seekCooldownTimer = setTimeout(() => { isSeeking = false; }, 400);
  }

  function onTimeUpdate() {
    if (stopped || !videoEl) return;
    const cur = videoEl.currentTime;
    if (lastRecordedTime !== null && !isSeeking) {
      if (Math.abs(cur - lastRecordedTime) > 1.8 || cur < lastRecordedTime - 0.5) {
        onSeeked();
      }
    }
    lastRecordedTime = cur;
  }

  function onPlayOrRestart() {
    if (stopped || !videoEl) return;
    if (videoEl.currentTime < 2.0) {
      onSeeked();
    }
  }

  const mediaListeners = {
    seeking: onSeeking,
    seeked: onSeeked,
    timeupdate: onTimeUpdate,
    play: onPlayOrRestart,
    playing: onPlayOrRestart,
    loadstart: onSeeking,
    loadeddata: onSeeked,
    emptied: onSeeking,
    ended: onSeeking
  };

  function attachMediaListeners(m) {
    if (!m) return;
    lastRecordedTime = m.currentTime;
    for (const [evt, fn] of Object.entries(mediaListeners)) {
      m.addEventListener(evt, fn);
    }
    attachTextTracks(m);
  }

  function detachMediaListeners(m) {
    if (!m) return;
    for (const [evt, fn] of Object.entries(mediaListeners)) {
      m.removeEventListener(evt, fn);
    }
    detachTextTracks(m);
  }

  function onTracksChanged() {
    if (stopped || !videoEl) return;
    const t = findTrack(videoEl);
    if (t && t !== activeTrack) {
      if (activeTrack) activeTrack.removeEventListener('cuechange', onCueChange);
      activeTrack = t;
      if (activeTrack.language && activeTrack.language !== 'und') {
        cfg.trackLang = activeTrack.language.toLowerCase().split('-')[0];
      }
      if (activeTrack.mode === 'disabled') activeTrack.mode = 'hidden';
      activeTrack.addEventListener('cuechange', onCueChange);
    }
  }

  function attachTextTracks(m) {
    if (!m || !m.textTracks) return;
    try {
      m.textTracks.addEventListener('addtrack', onTracksChanged);
      m.textTracks.addEventListener('change', onTracksChanged);
    } catch(e) {}
  }

  function detachTextTracks(m) {
    if (!m || !m.textTracks) return;
    try {
      m.textTracks.removeEventListener('addtrack', onTracksChanged);
      m.textTracks.removeEventListener('change', onTracksChanged);
    } catch(e) {}
    if (activeTrack) {
      activeTrack.removeEventListener('cuechange', onCueChange);
      activeTrack = null;
    }
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

  function cleanSubtitle(t) {
    let str = String(t || '');
    
    // Aggressively remove hidden screen-reader text injected by YouTube and other players
    const uiArtifacts = [
        /[^\(\)]+\s*\((?:auto-generated|generados automáticamente|généré automáticamente|automatisch|gerado automaticamente|generati automáticamente|автоматически|自動生成|자동 생성|自动生成)[^\)]*\)/gi,
        /(?:haz clic|click|cliquez|klicken|fare clic|clique).*?(?:configuración|settings|paramètres|einstellungen|impostazioni|configurações)/gi,
        /(?:turn off subtitles|desactivar subtítulos|désactiver les sous-titres|untertitel deaktivieren|desativar legendas|disattiva sottotitoli)/gi,
        /(?:keyboard shortcuts|atajos de teclado|raccourcis clavier|tastaturkürzel|atalhos de teclado|scorciatoie da tastiera)/gi
    ];
    uiArtifacts.forEach(rx => { str = str.replace(rx, ' '); });

    // Strip WebVTT timestamp and position formatting if present
    str = str.replace(/\d{2}:\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[\.,]\d{3}/g, '');
    str = str.replace(/align:[a-z]+|size:\d+%|position:\d+%/gi, '');

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
        return size;
      }
    }

    // Secondary check: full containment within the recent committed window
    if (normInc.length >= 2 && normCom.length >= normInc.length) {
      const searchWindow = normCom.slice(-40);
      const incStr = normInc.join(' ');
      const winStr = searchWindow.join(' ');
      if (winStr.includes(incStr)) {
        return normInc.length;
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
      if (isPrefix) return pending;
    }

    if (incoming.length > pending.length) {
      let isPrefix = true;
      for (let i = 0; i < pending.length; i++) {
        if (normP[i] !== normI[i]) { isPrefix = false; break; }
      }
      if (isPrefix) return incoming;
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

  // Strict ad detection scoped to the player to prevent false positives from webpage banner ads
  function isAdPlaying() {
    if (window.location.hostname.includes('youtube.com')) {
      return !!document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay');
    }
    if (window.location.hostname.includes('twitch.tv')) {
      return !!document.querySelector('[data-test-selector="sad-overlay"]');
    }
    const scope = getPlayerScope(videoEl);
    if (scope && (scope.classList.contains('vjs-ad-playing') || scope.classList.contains('ad-showing'))) {
      return true;
    }
    return false;
  }

  function findAllMedia(root = document) {
    let media = [];
    try {
      const list = Array.from(root.querySelectorAll('video, audio'));
      media.push(...list);
    } catch(e) {}

    try {
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          media.push(...findAllMedia(el.shadowRoot));
        }
      }
    } catch(e) {}

    try {
      const iframes = root.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) {
            media.push(...findAllMedia(doc));
          }
        } catch(e) {}
      }
    } catch(e) {}

    return media;
  }

  function findBestMedia() {
    const all = findAllMedia(document);
    if (!all.length) return null;

    let best = null;
    let bestScore = -Infinity;

    const winW = window.innerWidth || document.documentElement.clientWidth || 800;
    const winH = window.innerHeight || document.documentElement.clientHeight || 600;

    for (const m of all) {
      let score = 0;
      const isVideo = m.tagName.toLowerCase() === 'video';

      if (!m.paused && m.currentTime > 0 && !m.ended) {
        score += 100000;
      }

      try {
        if (m.textTracks && m.textTracks.length > 0) {
          score += 20000;
          for (let i = 0; i < m.textTracks.length; i++) {
            const t = m.textTracks[i];
            if (t.mode === 'showing' || (t.activeCues && t.activeCues.length > 0)) {
              score += 15000;
              break;
            }
          }
        }
      } catch(e) {}

      try {
        if (m.querySelectorAll('track').length > 0) {
          score += 10000;
        }
      } catch(e) {}

      let area = 0;
      try {
        const rect = m.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.top < winH && rect.right > 0 && rect.left < winW;
        if (inView) score += 15000;
        area = Math.max(0, rect.width) * Math.max(0, rect.height);
      } catch(e) {
        area = (m.offsetWidth || 0) * (m.offsetHeight || 0);
      }

      if (m.videoWidth && m.videoHeight) {
        area = Math.max(area, m.videoWidth * m.videoHeight);
      }
      score += Math.min(area, 50000);

      if (!m.muted && m.volume > 0) score += 5000;
      if (m.readyState >= 2) score += 2000;
      if (m.duration > 0) score += 1000;
      if (isVideo) score += 1000;

      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    return best;
  }

  function findTrack(v) {
    if (!v) return null;
    const ts = Array.from(v.textTracks || []);
    if (!ts.length) return null;

    let track = ts.find(t => t.mode === 'showing');
    if (track) return track;

    // Only search by explicit preference if not set to "AUTO"
    if (cfg.sttsSelectedLanguage && cfg.sttsSelectedLanguage.toUpperCase() !== 'AUTO') {
      const pref = cfg.sttsSelectedLanguage.toLowerCase();
      track = ts.find(t => (t.language || '').toLowerCase().startsWith(pref));
      if (track) { track.mode = 'hidden'; return track; }
    }

    track = ts.find(t => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'hidden');
    if (track) return track;

    track = ts.find(t => t.kind === 'subtitles' || t.kind === 'captions');
    if (track) { track.mode = 'hidden'; return track; }

    track = ts.find(t => (t.cues && t.cues.length > 0) || t.default);
    if (track) { track.mode = 'hidden'; return track; }

    if (ts[0]) { ts[0].mode = 'hidden'; return ts[0]; }

    return null;
  }

  const DOM_SELS = [
    { c: '.vjs-text-track-display',                   t: '.vjs-text-track-cue, .vjs-text-track-display div' },
    { c: '.ytp-caption-window-container',              t: '.ytp-caption-segment' },
    { c: '.player-captions-container__caption-window', t: '.player-captions-container__caption-line' },
    { c: '.bmpui-ui-subtitle-overlay, .bmpui-subtitle-region-container', t: '.bmpui-ui-subtitle-label, span' },
    { c: '.jw-captions, .jw-text-track-display',       t: '.jw-text-track-cue, .jw-cue' },
    { c: '.plyr__captions',                           t: '.plyr__caption' },
    { c: '.shaka-text-container',                     t: 'span, div' },
    { c: '.mejs__captions-layer',                     t: '.mejs__captions-text' },
    { c: '.able-captions-wrapper',                     t: '.able-captions' },
    { c: '.fp-captions',                              t: 'p' },
    { c: '.dmp_subtitles',                            t: 'span' },
    { c: '.player-timedtext',                         t: '.player-timedtext-text-container' },
    { c: '#captions-overlay',                         t: 'span' },
  ];

  function getPlayerScope(v) {
    if (!v) return null;
    try {
      return v.closest(
        '.video-js, .jwplayer, .plyr, .bmpui-ui-uicontainer, ' +
        '[class*="player-wrapper" i], [class*="player-container" i]'
      ) || null;
    } catch (e) { return null; }
  }

  function getDomText() {
    const scope = getPlayerScope(videoEl) || document;

    // 1. In Video.js (DW), visible text resides directly within .vjs-text-track-display
    const vjsDisplay = scope.querySelector('.vjs-text-track-display');
    if (vjsDisplay) {
      const text = norm(vjsDisplay.textContent);
      if (text) return text;
    }

    // 2. If an active selector is configured
    if (activeSel) {
      const root = activeSel.root || scope;
      const cc = root.querySelector(activeSel.c);
      if (cc) {
        const text = norm(cc.textContent);
        if (text) return text;
      }
    }

    // 3. Fallback to standard selectors
    for (const s of DOM_SELS) {
      const el = scope.querySelector(s.c);
      if (el) {
        const text = norm(el.textContent);
        if (text) return text;
      }
    }

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

  function accumulateText(rawText) {
    if (stopped || isSeeking || isAdPlaying()) return;

    const clean = cleanSubtitle(rawText || '');

    if (!clean) {
      if (lastSeenText !== '') {
        lastSeenText = '';
        if (pendingWords.length > 0) {
          clearTimeout(debTimer);
          clearTimeout(silenceTimer);
          // On subtitle cue gap, force prompt commit to speak in sync
          silenceTimer = setTimeout(forceFlushPending, 400);
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

  function evaluateCommit() {
    const wc = pendingWords.length;
    if (!wc) return;

    // Include colon (:) frequently used in German / DW subtitles
    const RE_PUNCT = /[.!?:\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    const RE_OPEN_Q   = /^[\u00bf\u00a1]/;

    const lastWord  = pendingWords[wc - 1] || '';
    const hasPunct  = RE_PUNCT.test(lastWord);

    // ── Internal splitting ──────────────────────────────────────────────────
    let internalSplitIdx = -1;
    for (let i = Math.max(1, P.MIN_FRAG - 1); i < wc - 1; i++) {
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

    // ── Last-word evaluation ─────────────────────────────────────────────────
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
        debTimer = setTimeout(forceFlushPending, 2000);
      }
    } else {
      clearTimeout(debTimer);
      debTimer = setTimeout(forceFlushPending, 2500);
    }

    if (pendingWords.length >= P.HARD_COMMIT) {
      forceFlushPending();
    }
  }

  function softFlushPending() {
    clearTimeout(debTimer);
    if (!pendingWords.length) return;

    const wc = pendingWords.length;
    const RE_PUNCT = /[.!?:\u2026\u3002\uFF01\uFF1F\u061F\u0964\u0965;\u061B\uFF1B\u0964\u0965]\p{M}*["'\])}\u00bb\u201D\u2019]*$/u;
    
    if (RE_PUNCT.test(pendingWords[wc - 1])) {
      forceFlushPending();
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
    } else if (wc >= P.MIN_FRAG) {
      forceFlushPending();
    }
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

  function startObs(sel) {
    activeSel = sel;
    const root = sel.root || document;
    const c = root.querySelector(sel.c);
    if (!c) return false;
    if (obs) obs.disconnect();
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

  function speak(text, lang, utteranceId) {
    if (!chrome.runtime?.id) return;
    console.log('[SubtitleTTS] 🔊 Speaking via TTS:', text, 'lang:', lang);
    chrome.runtime.sendMessage(
      { action: 'subtitleSpeak', text: norm(text), lang: lang || '', ttsSpeed: cfg.ttsSpeed, utteranceId },
      () => void chrome.runtime.lastError
    );
  }

  function commitText(text) {
    const t = norm(text);
    if (skip(t)) return;

    const now = Date.now();
    // Extended deduplication window to 30 seconds
    recentCommittedTexts = recentCommittedTexts.filter(item => now - item.ts < 30000);

    const normT = t.toLowerCase().replace(/[.,!?;:'"…\s]+/g, '');
    
    // Duplicate check by equality or substring containment (prevents YouTube rolling caption loops)
    const isDup = recentCommittedTexts.some(item => {
      const normOld = item.text.toLowerCase().replace(/[.,!?;:'"…\s]+/g, '');
      if (normOld === normT) return true;
      if (normT.length >= 12 && (normOld.includes(normT) || normT.includes(normOld))) return true;
      if (normOld.length > 15 && (normOld.startsWith(normT) || normT.startsWith(normOld))) return true;
      return false;
    });

    if (isDup) {
      console.log('[SubtitleTTS] ⏭️ Duplicate skipped:', t);
      return;
    }

    console.log('[SubtitleTTS] 📝 Confirmed sentence:', t);
    recentCommittedTexts.push({ text: t, ts: now });
    cueQueue.push({ text: t, ts: now });
    syncVideoSpeed();
    if (!isSpeaking) processQueue();
  }

  function onDone(utteranceId) {
    if (utteranceId && currentActiveUtteranceId && utteranceId !== currentActiveUtteranceId) {
      return;
    }
    clearTimeout(ttsId);
    ttsId = null;
    isSpeaking = false;
    isTtsSpeaking = false;
    currentActiveUtteranceId = 0;
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

    const thisEpoch = currentSessionEpoch;
    const thisUtteranceId = ++localUtteranceCounter;
    currentActiveUtteranceId = thisUtteranceId;

    // ── Dynamic source language determination ────────────────────────────
    let currentSrcLang = '';

    // 1. Explicit user selection from dropdown (other than AUTO)
    if (cfg.sttsSelectedLanguage && cfg.sttsSelectedLanguage.toUpperCase() !== 'AUTO') {
      currentSrcLang = cfg.sttsSelectedLanguage.toLowerCase().split('-')[0];
    }
    // 2. Valid native language reported by the video track
    else if (cfg.trackLang && cfg.trackLang !== 'und' && cfg.trackLang.toUpperCase() !== 'AUTO') {
      currentSrcLang = cfg.trackLang.toLowerCase().split('-')[0];
    }
    // 3. Language previously detected for this video stream
    else if (detectedLang) {
      currentSrcLang = detectedLang;
    }

    // 4. If still unknown (Auto Detect mode), detect automatically from text
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

    if (stopped || thisEpoch !== currentSessionEpoch) {
      isSpeaking = false;
      return;
    }

    const needsTrans = cfg.enableGeminiTranslation;

    if (needsTrans) {
      showContent(item.text, '', 'Translating...', currentSrcLang);
      const tail = recentTrans.slice(-2).join(' ');
      if (chrome.runtime?.id) {
        // 12-second safety watchdog so the queue never deadlocks
        const safetyTimeout = setTimeout(() => {
          if (currentActiveUtteranceId === thisUtteranceId) onDone(thisUtteranceId);
        }, 12000);

        chrome.runtime.sendMessage(
          { action: 'processTranslation', text: item.text, shownTail: tail, skipTts: true, sourceLang: currentSrcLang },
          (r) => {
            clearTimeout(safetyTimeout);
            void chrome.runtime.lastError;
            if (stopped || thisEpoch !== currentSessionEpoch) {
              isSpeaking = false;
              isTtsSpeaking = false;
              restoreCtrl();
              return;
            }
            
            const rawData = norm(r?.data || '');
            const cleanTr = rawData.replace(/^\u207A\s*/, '');
            const geminiError = r?.geminiError || '';
            
            // ── KEY SAFEGUARD: If translation returned empty (trimmed as duplicate or error) ──
            // NEVER display or speak the raw source text when translation was requested
            if (!cleanTr) {
              console.warn('[SubtitleTTS] ⏭️ Empty or duplicate-trimmed translation for:', item.text);
              setTimeout(() => onDone(thisUtteranceId), 50);
              return;
            }

            let statusMsg = 'Translation Active';
            if (geminiError) statusMsg = `GT fallback — Gemini: ${geminiError}`;
            else if (!r?.success) statusMsg = `Translation Error: ${r?.error || 'Unknown'}`;

            recentTrans.push(cleanTr);
            if (recentTrans.length > 10) recentTrans.shift();
            
            console.log('[SubtitleTTS] 🌐 Translation completed:', cleanTr);
            showContent(item.text, cleanTr, statusMsg, currentSrcLang);
            
            if (cfg.enableTts) {
              isTtsSpeaking = true;
              ttsId = setTimeout(() => onDone(thisUtteranceId), 20000);
              speak(cleanTr, cfg.targetLanguage, thisUtteranceId);
            } else {
              setTimeout(() => onDone(thisUtteranceId), 50);
            }
          }
        );
      }
    } else {
      showContent(item.text, '', '', currentSrcLang);
      if (cfg.enableTts) {
        isTtsSpeaking = true;
        ttsId = setTimeout(() => onDone(thisUtteranceId), 20000);
        speak(item.text, currentSrcLang || '', thisUtteranceId);
      } else {
        setTimeout(() => onDone(thisUtteranceId), 50);
      }
    }
  }

  function resetState() {
    clearTimeout(debTimer); 
    clearTimeout(silenceTimer); 
    clearTimeout(ttsId);
    isSpeaking = false;
    isTtsSpeaking = false;
    currentActiveUtteranceId = 0;
    pendingWords = [];
    committedWords = [];
    lastSeenText = '';
    cueQueue = [];
    recentTrans = [];
    recentCommittedTexts = [];
    debTimer = null;
    silenceTimer = null;
    ttsId = null;
    isTextTrackMode = false;
    isProgressiveMode = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('twitch.tv');
    _bmpSubtitleAttempted = false;
    cfg.trackLang = '';
    detectedLang = '';
  }

  function ensureSubtitlesActive() {
    try {
      const ytCc = document.querySelector('.ytp-subtitles-button');
      if (ytCc && ytCc.getAttribute('aria-pressed') === 'false') ytCc.click();

      const twitchCc = document.querySelector('[data-a-target="player-subtitles-button"]');
      if (twitchCc && twitchCc.getAttribute('aria-checked') === 'false') twitchCc.click();

      if (!_bmpSubtitleAttempted && !lastSeenText) {
        const bmpCc = document.querySelector('.bmpui-ui-subtitlesettingstogglebutton.bmpui-off');
        if (bmpCc) { bmpCc.click(); _bmpSubtitleAttempted = true; }
      }

      // Video.js (DW and others): clean activation via DOM menu click
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

      if (videoEl && videoEl.textTracks) {
        for (let i = 0; i < videoEl.textTracks.length; i++) {
          const t = videoEl.textTracks[i];
          if (t.kind === 'subtitles' || t.kind === 'captions') {
            if (t.mode === 'disabled') t.mode = 'showing';
          }
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

  function attachSubtitles() {
    if (!videoEl || stopped) return;

    // 1. DOM selector
    const sel = findDom();
    if (sel) {
      const root = sel.root || document;
      const c = root.querySelector(sel.c);
      if (c && c !== observedNode) {
        startObs(sel);
      }
    }

    // 2. Native TextTrack fallback (for standard HTML5 videos without DOM overlays)
    const t = findTrack(videoEl);
    if (t && t !== activeTrack) {
      if (activeTrack) activeTrack.removeEventListener('cuechange', onCueChange);
      activeTrack = t;
      if (activeTrack.language && activeTrack.language !== 'und') {
        cfg.trackLang = activeTrack.language.toLowerCase().split('-')[0];
      }
      if (activeTrack.mode === 'disabled') activeTrack.mode = 'hidden';
      activeTrack.addEventListener('cuechange', onCueChange);
    }
  }

  async function init(settings) {
    resetState();
    stopped = false;
    currentSessionEpoch++;
    clearContentHistory();

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

    videoEl = findBestMedia();
    if (!videoEl) {
      const startTime = Date.now();
      while (!videoEl && Date.now() - startTime < 8000) {
        await new Promise(r => setTimeout(r, 200));
        if (stopped) return { success: false, error: 'stopped' };
        videoEl = findBestMedia();
      }
    }

    if (!videoEl) return { success: false, error: 'no_video' };

    console.log('[SubtitleTTS] Media player located. Activating subtitles...');
    applyVideoVolume(true);
    ensureSubtitlesActive();
    attachMediaListeners(videoEl);
    updateHideNativeSubtitlesStyle();
    attachSubtitles();

    // 250ms DOM poller: guaranteed capture across any player
    if (domPollTimer) clearInterval(domPollTimer);
    domPollTimer = setInterval(() => {
      if (stopped || !chrome.runtime?.id) { 
        clearInterval(domPollTimer); 
        domPollTimer = null; 
        return; 
      }
      if (!isSeeking && !isAdPlaying()) {
        const text = getDomText();
        if (text || lastSeenText) {
          accumulateText(text);
        }
      }
    }, 250);

    if (bgSearch) clearInterval(bgSearch);
    bgSearch = setInterval(() => {
      if (stopped || !chrome.runtime?.id) { 
        clearInterval(bgSearch); 
        bgSearch = null; 
        return; 
      }
      
      const currentVideo = findBestMedia();
      if (currentVideo && currentVideo !== videoEl) {
        detachMediaListeners(videoEl);
        if (obs) { obs.disconnect(); obs = null; activeSel = null; observedNode = null; }
        videoEl = currentVideo;
        attachMediaListeners(videoEl);
        applyVideoVolume(true);
        resetState();
        currentSessionEpoch++;
        clearContentHistory();
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
    currentSessionEpoch++;
    if (bgSearch) { clearInterval(bgSearch); bgSearch = null; }
    if (domPollTimer) { clearInterval(domPollTimer); domPollTimer = null; }
    if (obs) { obs.disconnect(); obs = null; }
    if (videoEl) { detachMediaListeners(videoEl); videoEl = null; }
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
        onDone(req.utteranceId);
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
      // If switched to Auto, clear previous states to force fresh re-detection
      if (!cfg.sttsSelectedLanguage) {
        detectedLang = '';
        cfg.trackLang = '';
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
