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

  const DEB_COMMIT      = 1500;  // base timeout
  const MIN_WORDS_PUNCT = 1;     // commit early if sentence ends with ≥N words
  const HARD_COMMIT     = 35;    // force commit at this word count to allow longer sentences
  const MAX_AGE         = 30000;
  const MAX_Q           = 6;
  const MAX_COMMITTED   = 120;   // sliding window of committed words for dedup

  let videoEl = null, activeTrack = null, obs = null, activeSel = null;
  let isSpeaking = false, isTtsSpeaking = false;
  let cueQueue = [], recentTrans = [];
  let ttsId = null, stopped = false;

  // Accumulation state
  let pendingWords   = [];  // words not yet committed
  let committedWords = [];  // recently committed words (for dedup)
  let lastSeenText   = '';
  let debTimer       = null;

  let cfg = {
    playbackControl: 'pause', slowdownRate: 0.8,
    enableGeminiTranslation: false, enableTts: false,
    targetLanguage: 'en', ttsSpeed: 1.0, trackLang: '', sttsSelectedLanguage: '',
    hideNativeSubtitles: true, videoVolume: 1.0
  };

  const originalVideoVolumes = new Map();
  // We only skip labels like [music] or purely auto-generated tags. We don't skip short 1-word valid subtitles like "Yes."
  const SKIP = /auto.?generat|automatically|inaccurat|turn off subtitle|keyboard shortcut|^\[[a-z\s]+\]$/i;

  // Utilities
  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

  function cleanSubtitle(t) {
    return norm(
      String(t || '')
        .replace(/<[^>]+>/g, '')    // VTT timing/style tags
        .replace(/>+/g, '')         // all >> markers anywhere
        .replace(/^\s*-\s+/gm, '')  // leading dash variant
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // invisible chars
    );
  }

  function skip(t) { return !t || SKIP.test(t); }

  function sentenceEnds(words) {
    return /[.!?\u2026\u3002\uFF01\uFF1F]["'\])}»\u201D\u2019]*$/.test(words[words.length - 1] || '');
  }

  // Normalize a word for comparison: lowercase + strip trailing punctuation.
  function nw(w) { return w.toLowerCase().replace(/[.,!?;:'"\u2026\u2019]+$/, ''); }

  // Strictly match suffix of history with prefix of incoming, OR if history-suffix is prepended.
  function committedPrefixLength(committed, incoming) {
    const normCom = committed.map(nw);
    const normInc = incoming.map(nw);
    
    // 1. Strict overlap: End of history matches Start of incoming
    const maxOverlap = Math.min(normCom.length, normInc.length, 50);
    for (let size = maxOverlap; size >= 1; size--) {
      let match = true;
      for (let i = 0; i < size; i++) {
        if (normCom[normCom.length - size + i] !== normInc[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        return size;
      }
    }
    
    // 2. Loose overlap: The end of history (min 3 words) is embedded somewhere in incoming
    for (let n = Math.min(normCom.length, 50); n >= 3; n--) {
      const suffix = normCom.slice(normCom.length - n);
      for (let i = 1; i <= normInc.length - n; i++) {
        let match = true;
        for(let k = 0; k < n; k++){
          if(suffix[k] !== normInc[i+k]){ match = false; break; }
        }
        if (match) {
          return i + n; // Skip up to the end of this matched sequence
        }
      }
    }

    return 0;
  }

  // DOM / Track helpers
  function findVideo() {
    const all = Array.from(document.querySelectorAll('video'));
    return all.reduce((b, v) => (!b || v.offsetWidth * v.offsetHeight > b.offsetWidth * b.offsetHeight) ? v : b, null);
  }

  function findTrack(v) {
    if (!v) return null;
    const ts = Array.from(v.textTracks);
    if (!ts.length) return null;
    return ts.find(t => t.mode === 'showing')
        || ts.find(t => t.mode === 'hidden')
        || (() => { const p = ts.find(t => t.kind === 'subtitles' || t.kind === 'captions') || ts[0]; p.mode = 'hidden'; return p; })();
  }

  const DOM_SELS = [
    { c: '.ytp-caption-window-container',              t: '.ytp-caption-segment' },
    { c: '.player-captions-container__caption-window', t: '.player-captions-container__caption-line' },
    { c: '.vjs-text-track-display',                   t: '.vjs-text-track-cue' },
    { c: '#captions-overlay',                         t: '#captions-overlay span' },
    { c: '.player-timedtext',                         t: '.player-timedtext-text-container' },
  ];

  function getDomText() {
    if (!activeSel) return '';
    const ss = document.querySelectorAll(activeSel.t);
    if (ss.length) return norm(Array.from(ss).map(s => s.textContent).join(' '));
    const cc = document.querySelector(activeSel.c);
    return cc ? norm(cc.textContent) : '';
  }

  function findDom() {
    for (const s of DOM_SELS) if (document.querySelector(s.c)) return s;
    return null;
  }

  // Accumulation
  function accumulateText(rawText) {
    if (stopped) return;

    const clean = cleanSubtitle(rawText || '');
    
    // If the subtitle disappears (empty cue), accelerate flush timeout if pending words exist
    if (!clean) { 
      if (lastSeenText !== '') {
        lastSeenText = '';
        if (pendingWords.length > 0) {
          clearTimeout(debTimer);
          debTimer = setTimeout(flushPending, 1500);
        }
      }
      return; 
    }

    if (clean === lastSeenText) return;
    lastSeenText = clean;

    clearTimeout(debTimer);

    const allWords = clean.split(' ').filter(Boolean);
    const history = [...committedWords, ...pendingWords];

    const skip_ = committedPrefixLength(history, allWords);
    const fresh = allWords.slice(skip_);

    if (!fresh.length) {
      if (pendingWords.length) evaluateCommit();
      return;
    }

    if (skip_ > 0 || pendingWords.length === 0) {
      pendingWords = [...pendingWords, ...fresh];
    } else {
      // For consecutive cues with NO overlap, check if previous ended in punctuation.
      // If not, append it continuously to connect broken sentences.
      const lastWord = pendingWords[pendingWords.length - 1] || '';
      const hasStrongPunct = /[.!?\u2026\u3002\uFF01\uFF1F]["'\])}»\u201D\u2019]*$/.test(lastWord);
      
      if (hasStrongPunct) {
        flushPending();
        pendingWords = fresh;
      } else {
        pendingWords = [...pendingWords, ...fresh];
      }
    }

    evaluateCommit();
  }

  function evaluateCommit() {
    const wc = pendingWords.length;
    if (!wc) return;

    if (wc >= HARD_COMMIT) { flushPending(); return; }

    const lastWord = pendingWords[pendingWords.length - 1] || '';
    const hasStrongPunct = /[.!?\u2026\u3002\uFF01\uFF1F]["'\])}»\u201D\u2019]*$/.test(lastWord);
    const hasWeakPunct = /[,;:\-]["'\])}»\u201D\u2019]*$/.test(lastWord);

    if (hasStrongPunct && wc >= MIN_WORDS_PUNCT) {
      debTimer = setTimeout(flushPending, 400); // Fast flush when detecting period
    } else if (hasWeakPunct && wc >= 4) {
      debTimer = setTimeout(flushPending, 2000); // Medium flush for commas
    } else {
      debTimer = setTimeout(flushPending, 6000); // Allow time to fetch the next continuous cue
    }
  }

  function flushPending() {
    clearTimeout(debTimer);
    if (!pendingWords.length) return;
    const text = pendingWords.join(' ');
    pendingWords = [];
    lastSeenText = '';

    committedWords = [...committedWords, ...text.split(' ').filter(Boolean)];
    if (committedWords.length > MAX_COMMITTED) committedWords = committedWords.slice(-MAX_COMMITTED);

    commitText(text);
  }

  // Video sync
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

  // Event handlers
  function onMutation() { if (!stopped) accumulateText(getDomText()); }

  function onCueChange() {
    if (stopped || !activeTrack) return;
    const cues = activeTrack.activeCues;
    if (!cues || !cues.length) { accumulateText(''); return; }
    accumulateText(Array.from(cues).map(c => c.text || '').join(' '));
  }

  function startObs(sel) {
    activeSel = sel;
    const c = document.querySelector(sel.c);
    if (!c) return false;
    if (obs) obs.disconnect();
    obs = new MutationObserver(onMutation);
    obs.observe(c, { childList: true, subtree: true, characterData: true });
    console.log('[SubtitleTTS] DOM obs:', sel.c);
    return true;
  }

  // Display
  function showContent(orig, disp, statusText, currentSrcLang) {
    try {
      chrome.runtime.sendMessage(
        { type: 'subtitle_display', data: { original: orig, translated: disp, statusText: statusText, trackLang: currentSrcLang } },
        () => void chrome.runtime.lastError
      );
    } catch(e) {}
  }

  // Video control
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
          let isNew = false;
          if (!originalVideoVolumes.has(v)) {
            originalVideoVolumes.set(v, v.volume);
            isNew = true;
          }
          if (force || isNew) {
            v.volume = Math.max(0, Math.min(1, cfg.videoVolume));
          }
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

  // TTS queue
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
    console.log('[SubtitleTTS] commit:', t.slice(0, 80));
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
    while (cueQueue.length && (now - cueQueue[0].ts) > MAX_AGE) cueQueue.shift();
    while (cueQueue.length > MAX_Q) cueQueue.shift();
    const item = cueQueue.shift();
    if (!item) return;

    isSpeaking = true;
    syncVideoSpeed();

    let currentSrcLang = cfg.sttsSelectedLanguage || cfg.trackLang;

    // Auto-detect language natively if missing and we have enough text
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

  // Init / Stop
  function resetState() {
    clearTimeout(debTimer); clearTimeout(ttsId);
    isSpeaking = false; isTtsSpeaking = false;
    pendingWords = []; committedWords = []; lastSeenText = '';
    cueQueue = []; recentTrans = [];
    debTimer = null; ttsId = null;
  }

  async function init(settings) {
    resetState();
    stopped = false;
    if (settings) cfg = { ...cfg, ...settings };
    videoEl = findVideo();
    if (!videoEl) return { success: false, error: 'no_video' };
    applyVideoVolume(true);

    try {
      const ccBtn = document.querySelector('.ytp-subtitles-button');
      if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') ccBtn.click();
      if (cfg.hideNativeSubtitles !== false && !document.getElementById('stts-hide-cc')) {
        const s = document.createElement('style');
        s.id = 'stts-hide-cc';
        s.textContent = '.ytp-caption-window-container, .caption-window { opacity: 0.01 !important; pointer-events: none !important; }';
        document.head.appendChild(s);
      }
    } catch(e) {}

    const bgSearch = setInterval(() => {
      if (stopped) { clearInterval(bgSearch); return; }
      
      const currentVideo = findVideo();
      if (currentVideo !== videoEl) {
        if (obs) { obs.disconnect(); obs = null; activeSel = null; }
        if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
        videoEl = currentVideo;
        applyVideoVolume(true); 
      } else {
        applyVideoVolume(false); 
      }

      if (!videoEl) return;

      if (!activeTrack && !obs) {
        const t = findTrack(videoEl);
        if (t) {
          activeTrack = t;
          cfg.trackLang = activeTrack.language || '';
          if (activeTrack.mode === 'disabled') activeTrack.mode = 'hidden';
          activeTrack.addEventListener('cuechange', onCueChange);
          console.log('[SubtitleTTS] TextTrack lang:', cfg.trackLang);
        } else {
          const sel = findDom();
          if (sel && startObs(sel)) { console.log('[SubtitleTTS] DOM obs attached.'); }
        }
      } else if (activeTrack && activeTrack.mode === 'disabled') {
         activeTrack.removeEventListener('cuechange', onCueChange);
         activeTrack = null;
      } else if (obs && activeSel && !document.querySelector(activeSel.c)) {
         obs.disconnect(); obs = null; activeSel = null;
      }
    }, 1000);

    return { success: true };
  }

  function _cleanup() {
    stopped = true;
    if (obs) { obs.disconnect(); obs = null; }
    if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
    const s = document.getElementById('stts-hide-cc');
    if (s) s.remove();
    restoreCtrl(); restoreVideoVolume(); resetState(); activeSel = null;
  }

  function stop() {
    _cleanup();
    try { chrome.runtime.sendMessage({ action: 'stopTts' }, () => void chrome.runtime.lastError); } catch {}
    try { chrome.runtime.sendMessage({ type: 'STOP' },     () => void chrome.runtime.lastError); } catch {}
    console.log('[SubtitleTTS] Stopped.');
  }

  // Listeners
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
  }

  chrome.runtime.onMessage.addListener(onMsg);
  chrome.storage.onChanged.addListener(onStorageChange);
  window.__stts_onMsg     = onMsg;
  window.__stts_onStorage = onStorageChange;

  return { reinit: (s) => init(s), stop, _cleanup };
})();
