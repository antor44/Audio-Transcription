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

  // ── Profile-based accumulation parameters ────────────────────────────────
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

  // Detection state and diagnostics
  let detectedLang = '';
  let gotText = false;            // true once any subtitle text has been received
  let attachedKind = '';          // 'dom' | 'track' | 'generic' | 'file' | ''
  let attachedAt = 0;
  let fallbackTried = false;
  let lastDomRecheck = 0;
  let initAt = 0;
  // Search notice stage: 0 = none, 1 = "looking for subtitles", 2 = "turn on captions" hint
  let hintStage = 0;
  let playedMs = 0;       // Accumulated playback time while no subtitle source is attached
  let lastWatchAt = 0;
  let genericCache = null;
  const inlineHidden = new Map(); // element -> previous inline styles (for restoration)

  // File-based subtitle source (VTT / SRT / TTML detected via network resource timing)
  const fileCands = new Map();    // url -> { url, t }
  const fileTried = new Set();
  let fileTracks = [];            // [{ url, t, cues:[{s,e,text}], lang }]
  let fileTrack = null, fileTimer = null, fileLoading = false, perfObs = null;

  // ── Seek handler: resets in-flight state without discarding committed history ───
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
    playbackControl: 'pause', slowdownRate: 0.8, ownDocOnly: false,
    enableGeminiTranslation: false, enableTts: false,
    targetLanguage: 'en', ttsSpeed: 1.0, trackLang: '', sttsSelectedLanguage: '',
    hideNativeSubtitles: true, videoVolume: 1.0
  };

  const originalVideoVolumes = new Map();

  // Matches UI artifacts, keyboard shortcut notices, and auto-generated caption banners
  // that should be discarded rather than spoken aloud.
  const SKIP = /auto.?generat|(?:generad|généré|gerad|generat)\w*\s+autom|automatisch\s+(?:generiert|erzeugt)|автоматически\s+создан|automatic captions|inaccurat|turn off subtitle|desactivar\s+subt|désactiver\s+les\s+sous|keyboard shortcut|atajos\s+de\s+teclado|^\[[\p{L}\s]+\]$|^(?:[A-Za-zÀ-ÿ\s]+)\s*\([^\)]+\)$/iu;

  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

  // ── Subtitle text cleaner: strips HTML, timing artifacts, and UI banners ────────
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

  // ── Overlap detection: finds committed word prefix shared with incoming text ──────
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

  // ── Word accumulator: merges overlapping or extending caption chunks ──────────────
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

  // ── Ad detection: checks known player ad states to suppress TTS during ads ────────
  // Generic fallback: many players show an "Ad" badge, an "Ad 1 of 2" counter or a "Skip ad" control over
  // the video while an ad plays. Subtitle files loaded for the main video must not be read against the ad
  // timeline, so text is ignored while such a label is visible. The scan is cached to stay cheap.
  const AD_LABEL_RE = /^(?:ads?|advertisements?|sponsored|publicidad|anuncios?|publicit[\u00e9e]|werbung|anzeige|pubblicit[\u00e0a]|annuncio|publicidade)$|^(?:ad|ads|anuncio|publicidad|werbung)\s*[:\u00b7-]?\s*\d+\s*(?:of|de|von|sur|di)\s*\d+$|^skip\s+ads?$|^saltar\s+(?:el\s+)?anuncio$/i;
  let adScan = { ts: 0, val: false };
  let adWas = false;
  let fileTimeOffset = 0;   // Seconds between video.currentTime and the start of the main video (see noteAdTransition)

  // Some players keep one continuous media timeline after a pre-roll ad, so the main video starts at the
  // ad's duration instead of 0, while subtitle files are timed from the start of the main video.
  // The offset is measured when an ad ends, only before any subtitle text was delivered and only for
  // plausible ad lengths, so mid-roll ads and players that reset the timeline are not affected.
  function noteAdTransition(isAd) {
    if (isAd === adWas) return;
    adWas = isAd;
    if (isAd || !videoEl) return;
    const tEnd = videoEl.currentTime || 0;
    if (!gotText && tEnd > 4 && tEnd < 120) fileTimeOffset = tEnd;
  }

  function hasAdOverlay() {
    const now = Date.now();
    if (now - adScan.ts < (adScan.val ? 250 : 1000)) return adScan.val;
    let found = false;
    try {
      if (videoEl) {
        const vr = videoEl.getBoundingClientRect();
        let n = 0;
        for (const el of getSearchRoot(videoEl).querySelectorAll('span, div, p, a, button')) {
          if (++n > 1500) break;
          if (el.childElementCount) continue;
          const t = norm(el.textContent);
          if (!t || t.length > 24 || !AD_LABEL_RE.test(t)) continue;
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (!(r.width > 0 && r.height > 0 && cx >= vr.left && cx <= vr.right && cy >= vr.top && cy <= vr.bottom)) continue;
          if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
          found = true;
          break;
        }
      }
    } catch (e) {}
    adScan = { ts: now, val: found };
    noteAdTransition(found);
    return found;
  }

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
    return hasAdOverlay();
  }

  function findAllMedia(root = document, ownOnly = cfg.ownDocOnly) {
    let media = [];
    try {
      media.push(...Array.from(root.querySelectorAll('video')));
    } catch(e) {}
    try {
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) media.push(...findAllMedia(el.shadowRoot, ownOnly));
      }
    } catch(e) {}
    // Each frame has its own injected instance, so cross-frame DOM traversal is not needed
    if (!ownOnly) {
      try {
        for (const iframe of root.querySelectorAll('iframe')) {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) media.push(...findAllMedia(doc, ownOnly));
        }
      } catch(e) {}
    }
    return media;
  }

  // Visible area score, penalising decorative (looping muted) or unloaded videos
  function videoScore(v) {
    let sc = (v.offsetWidth || 0) * (v.offsetHeight || 0);
    if (v.loop && v.muted) sc *= 0.1;
    if (v.readyState === 0 && !v.currentSrc && !v.src) sc *= 0.5;
    // Video has a source but no rendered dimensions yet (e.g. loading inside an iframe):
    // assign a minimal score so frame probing still detects it as a candidate
    if (sc === 0 && (v.currentSrc || v.src || v.readyState > 0)) sc = 50;
    return sc;
  }

  function findVideo(ownOnly) {
    const all = findAllMedia(document, ownOnly === undefined ? cfg.ownDocOnly : ownOnly);
    return all.reduce((b, v) => (!b || videoScore(v) > videoScore(b)) ? v : b, null);
  }

  function isPlaying(v) {
    return !!v && !v.paused && !v.ended && v.readyState >= 2;
  }

  // Used by the service worker to select the best frame for initialisation.
  // An actively playing video outranks a paused one of similar size, so the frame that is
  // really being watched wins even when other frames hold larger idle players.
  function probe() {
    const v = findVideo(true);
    if (!v) return { hasVideo: false, score: 0, playing: false, url: location.href };
    const playing = isPlaying(v);
    const hasCaptions = Array.from(v.textTracks || []).some(isSubtitleTrack);
    const score = videoScore(v) * (playing ? 4 : 1) * (hasCaptions ? 1.25 : 1);
    return { hasVideo: true, score, playing, url: location.href };
  }

  function isSubtitleTrack(t) { return t.kind === 'subtitles' || t.kind === 'captions'; }

  function findTrack(v, opts = {}) {
    if (!v) return null;
    // Ignore chapter, metadata, and description tracks — subtitles/captions only
    const ts = Array.from(v.textTracks || []).filter(isSubtitleTrack);
    if (!ts.length) return null;

    let track = ts.find(t => t.mode === 'showing');
    if (track) return track;

    if (cfg.sttsSelectedLanguage && cfg.sttsSelectedLanguage.toUpperCase() !== 'AUTO') {
      const pref = cfg.sttsSelectedLanguage.toLowerCase();
      track = ts.find(t => (t.language || '').toLowerCase().startsWith(pref));
      if (track) return track;
    }

    let hiddenTrack = ts.find(t => t.mode === 'hidden');
    if (hiddenTrack) return hiddenTrack;

    // Last resort: tracks in "disabled" state — loaded by the site but not yet activated by the user.
    if (opts.allowDisabled) {
      const pageLang = String(document.documentElement.lang || navigator.language || '').toLowerCase().split('-')[0];
      return (pageLang && ts.find(t => (t.language || '').toLowerCase().startsWith(pageLang)))
          || ts.find(t => t.cues && t.cues.length)
          // In-band CEA-608/708 captions usually carry no language tag
          || ts.find(t => t.language === '')
          || ts[0];
    }
    return null;
  }

  function getPlayerScope(v) {
    if (!v) return null;
    try {
      return v.closest(
        '.video-js, .jwplayer, .plyr, .bmpui-ui-uicontainer, ' +
        '.theoplayer-container, [class*="theoplayer" i], ' +
        '[class*="player-wrapper" i], [class*="player-container" i], ' +
        // Common commercial player containers
        '[class*="bitmovin" i], [class*="anvato" i], ' +
        '[class*="video-wrapper" i], [class*="media-player" i]'
      ) || null;
    } catch (e) { return null; }
  }


  // ── Scoped DOM selectors matching dedicated subtitle containers ──────────
  // THEOplayer renders WebVTT cues inside per-track wrappers and regions. Only text with an explicit colour class
  // is wrapped in a "styling" span, so the track wrapper and region are matched as well; strict mode keeps the
  // outermost element of each group. Its video.js-based UI also ships an always-empty .vjs-text-track-display,
  // which is why this entry must come before the generic video.js one.
  const THEO_CUE = '[class*="theoplayer-webvtt-texttrack"], [class*="theoplayer-webvtt-region"], [class*="theoplayer-webvtt-styling"]';
  const THEO_BOX = '.theoplayer-texttracks, [class*="theoplayer-texttrack" i]';

  const DOM_SELS = [
    // THEOplayer: container resolved by findTheoContainer(); strict = read cue elements only, never the whole container
    { theo: true, strict: true, t: THEO_CUE },
    // YouTube
    { c: '.ytp-caption-window-container',                               t: '.ytp-caption-segment' },
    // Twitch
    { c: '.player-captions-container__caption-window',                  t: '.player-captions-container__caption-line' },
    // Video.js
    { c: '.vjs-text-track-display',                                     t: '.vjs-text-track-cue' },
    // Bitmovin
    { c: '.bmpui-ui-subtitle-overlay, .bmpui-subtitle-region-container', t: '.bmpui-ui-subtitle-label' },
    // Bitmovin: alternate region/label structures
    { c: '.bmpui-ui-subtitle-overlay',                                  t: '.bmpui-ui-subtitle-label, span' },
    // JW Player
    { c: '.jw-captions, .jw-text-track-display',                        t: '.jw-text-track-cue' },
    // Plyr
    { c: '.plyr__captions',                                            t: '.plyr__caption' },
    // Shaka
    { c: '.shaka-text-container',                                      t: '.shaka-text-wrapper' },
    // MediaElement
    { c: '.mejs__captions-layer',                                      t: '.mejs__captions-text' },
    // THEOPlayer
    { c: '.theoplayer-texttracks, .theo-captions-wrapper',             t: '.theoplayer-texttrack-cue-text, .vjs-text-track-cue' },
    // Generic subtitle overlay layer
    { c: '.rtve-subtitle-layer, .rtve-subtitle, [class*="subtitle-layer"]', t: 'span, p' },
    // EBU-TT-D / HBBtv player
    { c: '.ebu-tt-container, .ebuttd-container',                       t: 'p, span' },
    // Others
    { c: '.able-captions-wrapper',                                      t: '.able-captions' },
    { c: '.fp-captions',                                               t: 'p' },
    { c: '.dmp_subtitles',                                             t: '.dmp_subtitle_line' },
    { c: '#captions-overlay',                                          t: '#captions-overlay span' },
    { c: '.player-timedtext',                                          t: '.player-timedtext-text-container' },
  ];


  // ── Shadow DOM traversal: collects document and all open shadow roots ─────
  function collectRoots(root, out = [], depth = 0) {
    if (!root || depth > 6) return out;
    out.push(root);
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    for (const el of all) if (el.shadowRoot) collectRoots(el.shadowRoot, out, depth + 1);
    return out;
  }

  function deepQueryAll(root, sel) {
    const res = [];
    for (const r of collectRoots(root)) {
      try { for (const n of r.querySelectorAll(sel)) res.push(n); } catch (e) {}
    }
    return res;
  }

  // Extracts visible text from a container, joining text nodes and ignoring hidden/screen-reader elements
  const GEN_HIDDEN_SEL = '[hidden], .ytp-visually-hidden, [class*="visually-hidden" i], [class*="sr-only" i], [class*="screen-reader" i], [class*="a11y" i]';
  function collectText(el) {
    const parts = [];
    try {
      const doc = el.ownerDocument || document;
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (!p) continue;
        let hidden = false;
        for (let a = p; a; a = (a === el ? null : a.parentElement)) {
          if (a.matches && a.matches(GEN_HIDDEN_SEL)) { hidden = true; break; }
        }
        if (hidden) continue;
        if (typeof p.checkVisibility === 'function' && !p.checkVisibility({ checkVisibilityCSS: true })) continue;
        const t = norm(n.nodeValue);
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
    } catch (e) {}
    return norm(parts.join(' '));
  }

  // ── getDomText (container already resolved by startObs → observedNode) ─────
  function getDomText() {
    if (!activeSel || !observedNode || !observedNode.isConnected) return '';
    try {
      const container = observedNode;

      if (activeSel.generic) {
        const gt = collectText(container);
        return SKIP.test(gt) ? '' : gt;
      }

      const PURGE = '.ytp-visually-hidden, .cdx-visually-hidden, .ytp-caption-window-header, .ytp-caption-window-rollup, [style*="clip: rect(0"]';

      if (activeSel.t) {
        let ss = container.querySelectorAll(activeSel.t);
        if (activeSel.strict) {
          const all = Array.from(ss);
          ss = all.filter(x => !all.some(o => o !== x && o.contains(x)));   // keep only the outermost element of each cue group
        }
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
            // strict: join text nodes with spaces so separate lines or styled segments do not run together
            const txt = activeSel.strict ? collectText(s) : norm(clone.textContent);
            if (txt && !SKIP.test(txt)) {
              parts.push(txt);
            }
          }
          if (parts.length) return norm(parts.join(' '));
        }
      }

      // strict: with no visible cue there is no text (the container may also hold menus, titles, etc.)
      if (activeSel.strict) return '';

      // Container fallback
      const clone = container.cloneNode(true);
      const hidden = clone.querySelectorAll('.ytp-caption-window-top, ' + PURGE);
      hidden.forEach(el => el.remove());
      const res = norm(clone.textContent);
      return SKIP.test(res) ? '' : res;
    } catch (e) {}
    return '';
  }

  // Stable container for THEOplayer cues. The player creates several sibling .theoplayer-texttracks boxes under one
  // parent and only one of them holds the visible cue, so the common parent is observed instead of a single box.
  function findTheoContainer(roots) {
    let cue = null, firstBox = null;
    for (const r of roots) {
      try {
        if (!cue) cue = r.querySelector(THEO_CUE);
        if (!firstBox) firstBox = r.querySelector(THEO_BOX);
      } catch (e) {}
    }
    const box = cue ? cue.closest(THEO_BOX) : firstBox;
    if (box) return box.parentElement || box;
    if (!cue) return null;
    const root = videoEl ? getSearchRoot(videoEl) : null;
    if (root && root.contains && root.contains(cue)) return root;
    return cue.parentElement && cue.parentElement.parentElement || cue.parentElement;
  }

  // Searches known subtitle containers, including those inside shadow DOM roots
  function findDom() {
    const scope = getPlayerScope(videoEl);
    const scopes = scope ? [scope, document] : [document];
    for (const sc of scopes) {
      const roots = collectRoots(sc);
      for (const s of DOM_SELS) {
        if (s.theo) {
          const tc = findTheoContainer(roots);
          if (tc && tc.isConnected) return { ...s, c: 'theoplayer-webvtt-styling', root: sc, container: tc };
          continue;
        }
        for (const r of roots) {
          try {
            const c = r.querySelector(s.c);
            if (c && c.isConnected) return { ...s, root: sc, container: c };
          } catch (e) {}
        }
      }
    }
    return null;
  }

  // ── Generic player detection (heuristic container discovery) ─────────────
  const GEN_INCLUDE_RE = /subtitle|caption|timed-?text|sous-?titre|untertitel|sottotitol|subt[ií]tulo|(?:^|[\s_-])cues?(?:$|[\s_-])/i;
  const GEN_STRONG_RE  = /subtitle|caption|timed-?text|sous-?titre|untertitel|sottotitol|subt[ií]tulo/i;
  const GEN_EXCLUDE_RE = /button|btn|menu|toggle|icon|setting|option|select|dropdown|popup|popover|modal|dialog|tooltip|picker|switch|control|thumb|preview|list|lang(?:uage)?s?(?:$|[\s_-])|announce|live-?region|sr-only|visually-hidden|screen-?reader|a11y|shortcut|figcaption|transcript/i;
  const GEN_BAD_TAG = new Set(['BUTTON','A','LI','UL','OL','INPUT','SELECT','LABEL','TABLE','FIGCAPTION','H1','H2','H3','H4','H5','H6','SCRIPT','STYLE','SVG','PATH','VIDEO','SOURCE','TRACK','NOSCRIPT']);
  const GEN_BAD_ROLE = /^(button|menu|menuitem|menuitemradio|menuitemcheckbox|option|listbox|tab|switch|checkbox|dialog)$/;

  // Walks up the DOM to find the tightest ancestor that still contains the video element
  function getSearchRoot(v) {
    try {
      const vr = v.getBoundingClientRect();
      let best = v.parentElement || v.getRootNode();
      let el = v.parentElement;
      for (let i = 0; el && i < 10; i++) {
        const r = el.getBoundingClientRect();
        if (vr.width && (r.width > vr.width * 1.6 + 40 || r.height > vr.height * 1.6 + 40)) break;
        best = el;
        const rn = el.getRootNode && el.getRootNode();
        el = el.parentElement || ((rn && rn.host) ? rn.host : null);
      }
      return best;
    } catch (e) { return document; }
  }

  function scanGeneric(target) {
    const v = target || videoEl;
    if (!v) return [];
    const cacheable = v === videoEl;
    const now = Date.now();
    const interval = (now - initAt > 30000) ? 8000 : 2500;
    if (cacheable && genericCache && now - genericCache.ts < interval) return genericCache.list;

    let list = [];
    try {
      const vr = v.getBoundingClientRect();
      const seen = new Set();

      const evaluate = (el, needText) => {
        if (seen.has(el) || el === v) return;
        seen.add(el);
        if (GEN_BAD_TAG.has(String(el.tagName).toUpperCase())) return;
        const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
        if (!GEN_INCLUDE_RE.test(cls) || GEN_EXCLUDE_RE.test(cls)) return;
        if (GEN_BAD_ROLE.test(el.getAttribute('role') || '')) return;
        if (el.getElementsByTagName('*').length > 40) return;
        if (el.querySelector('video, button, input, select, a[href], [role="menuitem"], [role="option"], [role="menuitemradio"]')) return;

        let text = collectText(el);
        if (text.length > 400 || SKIP.test(text)) text = '';

        const r = el.getBoundingClientRect();
        let overlaps = true;   // If video dimensions are not yet available, do not discard
        if (vr.width > 0) {
          overlaps = r.width > 0 && r.height > 0 &&
            (r.left + r.width / 2) >= vr.left && (r.left + r.width / 2) <= vr.right &&
            (r.top + r.height / 2) >= vr.top && (r.top + r.height / 2) <= vr.bottom;
        }
        const pos = getComputedStyle(el).position;
        const overlay = pos === 'absolute' || pos === 'fixed';

        if (text) {
          if (!overlaps) return;                                  // Exclude external elements outside video bounds
        } else {
          if (needText || !overlay || !GEN_STRONG_RE.test(cls)) return;   // empty candidates: only overlays with an explicit subtitle-like class name
        }

        let score = GEN_STRONG_RE.test(cls) ? 3 : 1;
        if (text) score += 4;
        if (overlaps) score += 2;
        if (overlay) score += 1;
        list.push({ el, text, score, cls });
      };

      // 1) search within the player container
      for (const el of deepQueryAll(getSearchRoot(v), '[class], [id]')) evaluate(el, false);
      // 2) if nothing found with text, broaden to any element with text overlapping the video
      if (!list.some(c => c.text) && document.body) {
        for (const el of deepQueryAll(document.body, '[class], [id]')) evaluate(el, true);
      }

      // Keep only the outermost container in each nested group
      list = list.filter(c => !list.some(o => o !== c && o.el.contains(c.el)));
      list.sort((a, b) => b.score - a.score);
    } catch (e) { list = []; }

    if (cacheable) genericCache = { ts: now, list };
    return list;
  }

  function findGenericDom(withText) {
    const list = scanGeneric();
    const c = list.find(x => withText ? !!x.text : true);
    return c ? { generic: true, container: c.el, root: null, c: null, t: null } : null;
  }

  // Hides the native subtitle container when it cannot be reached by the global stylesheet
  function applyInlineHide() {
    const el = observedNode;
    if (!el || cfg.hideNativeSubtitles === false) return;
    try {
      if (!inlineHidden.has(el)) {
        inlineHidden.set(el, {
          o: el.style.getPropertyValue('opacity'), oP: el.style.getPropertyPriority('opacity'),
          p: el.style.getPropertyValue('pointer-events'), pP: el.style.getPropertyPriority('pointer-events')
        });
      }
      el.style.setProperty('opacity', '0.01', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    } catch (e) {}
  }

  function restoreInlineHide() {
    inlineHidden.forEach((prev, el) => {
      try {
        if (prev.o) el.style.setProperty('opacity', prev.o, prev.oP); else el.style.removeProperty('opacity');
        if (prev.p) el.style.setProperty('pointer-events', prev.p, prev.pP); else el.style.removeProperty('pointer-events');
      } catch (e) {}
    });
    inlineHidden.clear();
  }

  // Returns a diagnostics snapshot of this frame. Each frame has its own instance, so a complete
  // picture requires one snapshot per frame (see diagnoseSubtitleTts in the service worker).
  function diagnose() {
    const out = { frame: location.href, isTop: window.top === window, api: true, active: !stopped && !!videoEl, attached: attachedKind || 'none', gotText, videos: [], knownDom: null, generic: [] };
    // Inspect the active video, or the best candidate in this document when not initialised yet
    const target = videoEl || findVideo(true);
    try {
      out.videos = findAllMedia(document, true).map(v => ({
        w: v.offsetWidth, h: v.offsetHeight, paused: v.paused, muted: v.muted, rs: v.readyState,
        t: Math.round(v.currentTime || 0), main: v === target,
        src: String(v.currentSrc || v.src || '').slice(0, 90),
        tracks: Array.from(v.textTracks || []).map(t => ({ kind: t.kind, lang: t.language, label: t.label, mode: t.mode, cues: t.cues ? t.cues.length : null, active: t.activeCues ? t.activeCues.length : null }))
      }));
    } catch (e) {}
    try {
      const prev = videoEl;
      if (!videoEl) videoEl = target;
      try { const sel = findDom(); out.knownDom = sel ? sel.c : null; } finally { videoEl = prev; }
    } catch (e) {}
    try {
      out.generic = scanGeneric(target).slice(0, 6).map(c => ({ tag: c.el.tagName, cls: c.cls.trim().slice(0, 100), text: c.text.slice(0, 60), score: c.score }));
    } catch (e) {}

    // Subtitle files detected via network resource timing and their load status
    out.fileCandidates = Array.from(fileCands.keys()).slice(-8).map(u => u.slice(0, 140));
    try {
      if (fileTrack && videoEl) {
        const ft = videoEl.currentTime - fileTimeOffset;
        const cue = fileTrack.cues.find(c => ft >= c.s && ft < c.e);
        out.fileSync = { videoTime: Math.round(videoEl.currentTime * 10) / 10, offset: Math.round(fileTimeOffset * 10) / 10, duration: Math.round(videoEl.duration || 0), ad: adWas, cueStart: cue ? cue.s : null, cueText: cue ? cue.text.slice(0, 60) : null };
      }
    } catch (e) {}
    out.fileTracks = fileTracks.map(t => ({ url: t.url.slice(0, 100), cues: t.cues.length, lang: t.lang }));
    // Iframes present on the page (the player may reside in a child frame)
    try {
      out.iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12)
        .map(f => ({ src: String(f.src || '').slice(0, 110), w: f.offsetWidth, h: f.offsetHeight }));
    } catch (e) {}
    // Buttons whose labels or classes suggest subtitle/CC controls
    try {
      const CC_RE = /subtit|caption|cc|subt[ií]tulo|sous-?titre|untertitel|sottotitol/i;
      out.ccButtons = deepQueryAll(document, 'button, [role="button"], [role="switch"], [role="menuitem"], [role="menuitemradio"]')
        .map(b => ({ b, label: (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 40), cls: String(b.getAttribute('class') || '').slice(0, 70) }))
        .filter(x => CC_RE.test(x.label) || CC_RE.test(x.cls))
        .slice(0, 8)
        .map(x => ({ tag: x.b.tagName, label: x.label, cls: x.cls, pressed: x.b.getAttribute('aria-pressed') || x.b.getAttribute('aria-checked') || x.b.getAttribute('aria-selected') }));
    } catch (e) {}
    // Short visible text nodes overlapping the video, regardless of class names
    try {
      if (target) {
        const vr = target.getBoundingClientRect();
        const found = [];
        for (const el of deepQueryAll(getSearchRoot(target), '*').slice(0, 4000)) {
          if (found.length >= 10) break;
          if (el === target || GEN_BAD_TAG.has(String(el.tagName).toUpperCase())) continue;
          let own = '';
          for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
          own = norm(own);
          if (own.length < 2 || own.length > 200) continue;
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (!(r.width > 0 && cx >= vr.left && cx <= vr.right && cy >= vr.top && cy <= vr.bottom)) continue;
          found.push({ tag: el.tagName, cls: String(el.getAttribute('class') || '').slice(0, 80), text: own.slice(0, 60) });
        }
        out.textOverVideo = found;
      }
    } catch (e) {}
    return out;
  }

  // ── Main text accumulator: processes incoming subtitle text into the word buffer ──
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

    gotText = true;
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

  // ── Commit evaluator: decides when buffered words form a speakable sentence ────────
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

  // ── Soft flush: commits at the last sentence boundary, retaining trailing fragments 
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

  // ── Force flush: commits all buffered words immediately regardless of punctuation ──
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

  // Mutation callback: fires only on actual DOM text or child-list changes
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

  // Starts a MutationObserver on the resolved subtitle container (including shadow DOM roots)
  function startObs(sel) {
    const c = sel && sel.container;
    if (!c || !c.isConnected) return false;
    if (obs) obs.disconnect();
    activeSel = sel;
    isTextTrackMode = false;
    observedNode = c;
    obs = new MutationObserver(onMutation);
    obs.observe(c, { childList: true, subtree: true, characterData: true });
    if (sel.generic || (c.getRootNode && c.getRootNode() !== document)) applyInlineHide();
    // Read any caption that is already on screen when the source is attached
    setTimeout(() => { if (!stopped && obs && observedNode === c) onMutation(); }, 0);
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

  // ── Commit: validates and enqueues text for playback ─────────────────────────────
  function commitText(text) {
    const t = norm(text);
    if (skip(t)) return;

    cueQueue.push({ text: t, ts: Date.now() });
    syncVideoSpeed();
    if (!isSpeaking) processQueue();
  }

  // ── TTS completion handler: advances the playback queue ─────────────────────────
  function onDone() {
    clearTimeout(ttsId);
    ttsId = null;
    isSpeaking = false;
    isTtsSpeaking = false;
    syncVideoSpeed();
    if (!stopped) processQueue();
  }

  // ── Queue processor: handles translation, display and TTS for each committed item ─
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
    gotText = false;
    fallbackTried = false;
  }

  // ── Subtitle activation: programmatically enables CC in known player UIs ──────────
  // Clicks are bounded per video so the extension never keeps competing with the player or the
  // viewer once captions have been switched on (or deliberately off).
  const MAX_ACTIVATION_CLICKS = 4;
  let activationClicks = 0;

  function activate(el) {
    if (activationClicks >= MAX_ACTIVATION_CLICKS) return false;
    activationClicks++;
    el.click();
    return true;
  }

  function hasShowingCaptionTrack() {
    try {
      return !!videoEl && Array.from(videoEl.textTracks || []).some(t => isSubtitleTrack(t) && t.mode === 'showing');
    } catch (e) { return false; }
  }

  function ensureSubtitlesActive() {
    if (activationClicks >= MAX_ACTIVATION_CLICKS) return;
    try {
      const ytCc = document.querySelector('.ytp-subtitles-button');
      if (ytCc && ytCc.getAttribute('aria-pressed') === 'false' && activate(ytCc)) return;

      const twitchCc = document.querySelector('[data-a-target="player-subtitles-button"]');
      if (twitchCc && twitchCc.getAttribute('aria-checked') === 'false' && activate(twitchCc)) return;

      // Bitmovin subtitle toggle — only until the first subtitle text has been received
      if (!gotText) {
        const bmpCc = document.querySelector(
          '.bmpui-ui-subtitlesettingstogglebutton.bmpui-off, ' +
          '.bmpui-ui-subtitlelistbox .bmpui-ui-listitem:first-child'
        );
        if (bmpCc && activate(bmpCc)) return;
      }

      // Video.js caption menus: choose an entry only while captions are off, i.e. when no
      // regular (non-"off", non-settings) entry is selected and no text track is showing.
      if (hasShowingCaptionTrack()) return;
      const vjsScope = getPlayerScope(videoEl) || document;
      const vjsMenuItems = vjsScope.querySelectorAll(
        '.vjs-subs-caps-button .vjs-menu-item, ' +
        '.vjs-subtitles-button .vjs-menu-item, ' +
        '.vjs-captions-button .vjs-menu-item'
      );
      const usable = [];
      let anySelected = false;
      for (const item of vjsMenuItems) {
        const txt = (item.textContent || '').toLowerCase().trim();
        if (/off|desactiv|deaktiv|none|disabled/i.test(txt) || /setting|configura|einstellung/i.test(txt)) continue;
        usable.push(item);
        if (item.classList.contains('vjs-selected') || item.getAttribute('aria-checked') === 'true') anySelected = true;
      }
      if (usable.length && !anySelected) activate(usable[0]);
    } catch(e) {}
  }

  function updateHideStyleSheet() {
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
            .player-timedtext, .dmp_subtitles, .mejs__captions-layer,
            .theoplayer-texttracks, [class*="theoplayer-webvtt-styling"],
            .bmpui-ui-subtitle-overlay {
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

  function updateHideNativeSubtitlesStyle() {
    updateHideStyleSheet();
    if (cfg.hideNativeSubtitles !== false) {
      if (activeSel && observedNode && (activeSel.generic || observedNode.getRootNode() !== document)) applyInlineHide();
    } else {
      restoreInlineHide();
    }
  }

  // ═════════════ File-based subtitle source ══════════════════════════════════════
  // Handles players that load subtitles as external files (VTT/SRT/TTML) and render them
  // on a canvas, in a closed shadow DOM, or with unpredictable class names.
  // Discovered URLs are fetched and synchronised with video.currentTime.
  const SUB_NOISE_RE = /\.(?:m3u8|mpd|m4s|mp4|ts|jpe?g|png|gif|webp|svg|js|css|json|woff2?|ico)(?=$|[?#])|sitemap|rss|feed|manifest|thumbnail|thumb|sprite|storyboard|chapters?/i;
  const SUB_HINT_RE  = /subtitl|caption|subtit|sous-?titre|untertitel|sottotitol|timedtext|[_\-/.]subs?[_\-/.]|\/vtt\//i;

  function isSubtitleUrl(u) {
    if (!/^https?:/i.test(u)) return false;
    let path = u;
    try { const x = new URL(u); path = x.pathname + x.search; } catch (e) {}
    if (SUB_NOISE_RE.test(path)) return false;
    if (/\.(?:vtt|webvtt|srt|ttml|dfxp|ebuttd)(?=$|[?#])/i.test(path)) return true;
    if (/\.xml(?=$|[?#])/i.test(path) && SUB_HINT_RE.test(u)) return true;
    return SUB_HINT_RE.test(u) && /[?&](?:fmt|format|type|ext)=(?:vtt|srt|ttml|xml)/i.test(u);
  }

  function noteResource(url, t) {
    if (!url || fileCands.has(url) || !isSubtitleUrl(url)) return;
    fileCands.set(url, { url, t: (typeof t === 'number' ? t : performance.now()) });
    while (fileCands.size > 12) fileCands.delete(fileCands.keys().next().value);
  }

  function startResourceWatch() {
    if (perfObs) return;
    try { performance.setResourceTimingBufferSize(1500); } catch (e) {}
    try { performance.getEntriesByType('resource').forEach(e => noteResource(e.name, e.startTime)); } catch (e) {}
    try {
      perfObs = new PerformanceObserver(list => list.getEntries().forEach(e => noteResource(e.name, e.startTime)));
      perfObs.observe({ type: 'resource', buffered: true });
    } catch (e) { perfObs = null; }
  }
  function stopResourceWatch() {
    if (perfObs) { try { perfObs.disconnect(); } catch (e) {} perfObs = null; }
  }

  function decodeEntities(t) {
    return String(t)
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
      .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ' '; } })
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function clockToSec(str) {
    const parts = String(str).trim().replace(',', '.').split(':');
    let sec = 0;
    for (const p of parts) sec = sec * 60 + (parseFloat(p) || 0);
    return sec;
  }

  function parseVttSrt(text) {
    const cues = [];
    const TS = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => TS.test(l));
      if (i < 0) continue;
      const m = lines[i].match(TS);
      const body = norm(decodeEntities(lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '')));
      if (body) cues.push({ s: clockToSec(m[1]), e: clockToSec(m[2]), text: body });
    }
    return { cues, lang: '' };
  }

  function ttmlTime(v, fps, tickRate) {
    if (v == null) return null;
    v = String(v).trim();
    let m = v.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+)(?:\.\d+)?)?$/);
    if (m) {
      let sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      if (m[4]) sec += parseFloat('0.' + m[4]);
      else if (m[5]) sec += (+m[5]) / fps;
      return sec;
    }
    m = v.match(/^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/);
    if (m) {
      const n = parseFloat(m[1]);
      switch (m[2]) {
        case 'h': return n * 3600; case 'm': return n * 60; case 's': return n;
        case 'ms': return n / 1000; case 'f': return n / fps; case 't': return n / tickRate;
      }
    }
    return null;
  }

  function parseTtml(text) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); } catch (e) { return { cues: [], lang: '' }; }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return { cues: [], lang: '' };
    const root = doc.documentElement;
    const attr = (el, n) => el.getAttribute(n) || el.getAttribute('ttp:' + n) || el.getAttributeNS('http://www.w3.org/ns/ttml#parameter', n) || '';
    const fps = parseFloat(attr(root, 'frameRate')) || 30;
    const tickRate = parseFloat(attr(root, 'tickRate')) || 10000000;
    const lang = (root.getAttribute('xml:lang') || root.getAttribute('lang') || '').toLowerCase().split('-')[0];

    const cueText = (node) => {
      let out = '';
      for (const ch of Array.from(node.childNodes)) {
        if (ch.nodeType === 3) out += ch.nodeValue;
        else if (ch.nodeType === 1) out += (/(^|:)br$/i.test(ch.nodeName) ? ' ' : cueText(ch));
      }
      return out;
    };

    const cues = [];
    for (const p of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
      let base = 0;
      for (let a = p.parentElement; a && a !== root.parentNode; a = a.parentElement) {
        const b = ttmlTime(a.getAttribute('begin'), fps, tickRate);
        if (b != null) base += b;
      }
      let b = ttmlTime(p.getAttribute('begin'), fps, tickRate);
      let e = ttmlTime(p.getAttribute('end'), fps, tickRate);
      const d = ttmlTime(p.getAttribute('dur'), fps, tickRate);
      if (b == null) continue;
      if (e == null && d != null) e = b + d;
      if (e == null) continue;
      const body = norm(decodeEntities(cueText(p)));
      if (body) cues.push({ s: base + b, e: base + e, text: body });
    }
    return { cues, lang };
  }

  function parseSubtitleText(raw) {
    const t = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!t) return { cues: [], lang: '' };
    const head = t.slice(0, 4000);
    let res;
    if (/^WEBVTT/.test(t) || /-->/.test(head)) res = parseVttSrt(t);
    else if (/<(?:[\w-]+:)?tt[\s>]/i.test(t.slice(0, 3000))) res = parseTtml(t);
    else return { cues: [], lang: '' };
    const c = res.cues;
    // Discard thumbnail/storyboard VTT files (text is an image URL) and chapter tracks
    if (c.length && c.filter(x => /\.(?:jpe?g|png|webp|gif)(?:[#?]|$)/i.test(x.text)).length > c.length * 0.6) return { cues: [], lang: '' };
    c.sort((a, b) => a.s - b.s);
    return res;
  }

  async function fetchSubtitleText(url) {
    try {
      const r = await fetch(url);                 // try from the page first (same origin or CDN with open CORS)
      if (r.ok) { const tx = await r.text(); if (tx.length < 4e6) return tx; }
    } catch (e) {}
    try {                                          // fall back to the service worker (host permission, no CORS restrictions)
      const res = await new Promise(resolve => {
        const to = setTimeout(() => resolve(null), 12000);
        chrome.runtime.sendMessage({ action: 'fetchSubtitleFile', url }, (r) => { clearTimeout(to); void chrome.runtime.lastError; resolve(r); });
      });
      if (res && res.ok && typeof res.text === 'string') return res.text;
    } catch (e) {}
    return '';
  }

  function onFileTick() {
    if (stopped || !fileTrack || !videoEl || isSeeking) return;
    if (isAdPlaying()) return;   // Also refreshes the timeline offset when a pre-roll ends
    const t = videoEl.currentTime - fileTimeOffset + 0.05;
    const active = [];
    for (const c of fileTrack.cues) {
      if (c.s > t) break;
      if (t < c.e) active.push(c.text);
    }
    accumulateText(active.join(' '));
  }

  function stopFileDriver() {
    if (fileTimer) { clearInterval(fileTimer); fileTimer = null; }
    fileTrack = null;
  }

  function attachFileTrack(tr) {
    detachSource();                 // Detach existing DOM / track / generic listeners
    resetState();
    fileTrack = tr;
    attachedKind = 'file';
    attachedAt = Date.now();
    isTextTrackMode = true;         // Static cue stream behavior
    if (tr.lang && !cfg.sttsSelectedLanguage) cfg.trackLang = tr.lang;
    fileTimer = setInterval(onFileTick, 200);
  }

  function pickFileTrack(fresh) {
    const pool = fresh && fresh.length ? fresh : fileTracks;
    if (!pool.length) return null;
    const pref = (cfg.sttsSelectedLanguage || '').toLowerCase();
    if (pref) {
      const re = new RegExp('(?:^|[^a-z])' + pref.slice(0, 2) + '(?:[^a-z]|$)', 'i');
      const hit = pool.find(t => t.lang === pref.slice(0, 2) || re.test(t.url.split('?')[0].split('/').slice(-3).join('/')));
      if (hit) return hit;
    }
    // On first load the default track is usually requested first;
    // on subsequent loads prefer the most recently requested one (language or content change)
    const sorted = pool.slice().sort((a, b) => a.t - b.t);
    return fileTrack ? sorted[sorted.length - 1] : sorted[0];
  }

  function hasUntriedFiles() {
    for (const u of fileCands.keys()) if (!fileTried.has(u)) return true;
    return false;
  }

  async function loadFileSource() {
    if (fileLoading || stopped) return;
    const urls = Array.from(fileCands.values()).filter(c => !fileTried.has(c.url)).sort((a, b) => b.t - a.t).slice(0, 4);
    if (!urls.length) return;
    fileLoading = true;
    const fresh = [];
    try {
      for (const c of urls) {
        fileTried.add(c.url);
        const parsed = parseSubtitleText(await fetchSubtitleText(c.url));
        if (stopped) return;
        if (parsed.cues.length) {
          const tr = { url: c.url, t: c.t, cues: parsed.cues, lang: parsed.lang };
          fileTracks.push(tr); fresh.push(tr);
        }
      }
    } finally { fileLoading = false; }
    if (stopped || !fresh.length) return;
    // Do not override a DOM/track source that is already delivering text.
    // If already using a file track, only switch when a newer file is discovered.
    if ((attachedKind === 'dom' || attachedKind === 'track' || attachedKind === 'generic') && gotText) return;
    if (attachedKind === 'dom') return;
    const pick = pickFileTrack(fresh);
    if (pick && pick !== fileTrack) attachFileTrack(pick);
  }

  // Original mode of a track that was promoted by the extension (restored when the source is released)
  let promotedTrack = null;
  let promotedPrevMode = '';

  function restoreTrackMode() {
    if (promotedTrack) {
      try { if (promotedTrack.mode === 'showing') promotedTrack.mode = promotedPrevMode; } catch (e) {}
    }
    promotedTrack = null;
    promotedPrevMode = '';
  }

  function attachTrack(t) {
    activeTrack = t;
    cfg.trackLang = activeTrack.language || '';
    // Disabled tracks do not populate cues (e.g. Bitmovin and CEA-608 HLS players), so they are
    // switched to 'showing'; the native overlay is suppressed by the stts-hide-cc stylesheet.
    // Tracks already 'showing' or 'hidden' are left untouched.
    if (activeTrack.mode === 'disabled') {
      promotedTrack = activeTrack;
      promotedPrevMode = 'disabled';
      activeTrack.mode = 'showing';
    }
    activeTrack.addEventListener('cuechange', onCueChange);
  }

  function detachSource() {
    stopFileDriver();
    if (obs) { obs.disconnect(); obs = null; }
    if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
    restoreTrackMode();
    restoreInlineHide();
    activeSel = null;
    observedNode = null;
    attachedKind = '';
  }

  // Attachment priority: known DOM selectors → active/hidden text tracks → generic overlay with text
  //   → disabled text track (promoted to "hidden") → empty generic overlay
  function tryAttach(exclude) {
    let kind = '';
    if (exclude !== 'dom') {
      const sel = findDom();
      if (sel && startObs(sel)) kind = 'dom';
    }
    if (!kind && exclude !== 'track') {
      const t = findTrack(videoEl);
      if (t) { attachTrack(t); kind = 'track'; }
    }
    if (!kind && exclude !== 'generic') {
      const g = findGenericDom(true);
      if (g && startObs(g)) kind = 'generic';
    }
    if (!kind && exclude !== 'track') {
      const t = findTrack(videoEl, { allowDisabled: true });
      if (t) { attachTrack(t); kind = 'track'; }
    }
    if (!kind && exclude !== 'generic') {
      const g = findGenericDom(false);
      if (g && startObs(g)) kind = 'generic';
    }
    if (kind) { attachedKind = kind; attachedAt = Date.now(); }
    return kind;
  }

  function attachSubtitles() {
    if (!videoEl || stopped) return;
    if (fileTrack) return;      // Active file track is already in use

    if (!activeTrack && !obs) {
      tryAttach();
    } else if (activeTrack) {
      const trackValid = Array.from(videoEl.textTracks || []).includes(activeTrack);
      if (!trackValid || activeTrack.mode === 'disabled') {
        activeTrack.removeEventListener('cuechange', onCueChange);
        activeTrack = null;
        attachedKind = '';
        resetState();
      }
    } else if (obs) {
      // Use isConnected rather than document.body.contains to handle shadow DOM roots
      if (!observedNode || !observedNode.isConnected) {
        detachSource();
        resetState();
      }
    }
  }

  // ── Last-resort overlay detection ─────────────────────────────────────────────────
  // Some players draw captions as plain DOM text with unpredictable class names. This sampler
  // watches short text blocks in the lower part of the video and adopts one only after its text
  // has changed several times in a way that looks like speech rather than player chrome.
  const OVERLAY_INTERACTIVE = 'button, a[href], input, select, textarea, label, [role="button"], [role="menu"], [role="menuitem"], [role="slider"], [role="dialog"]';
  const OVERLAY_NOISE_RE = /\b\d{1,2}:\d{2}\b|^\W*(?:ads?|advertisement|publicidad|anuncio|skip|saltar|live|en\s+directo|en\s+vivo|up next|next|share|compartir)\b|cookie|privacy|consent|subscribe|volume|fullscreen/i;
  const OVERLAY_MIN_CHANGES = 4;
  const overlayStats = new Map();   // structural signature -> { texts: Set, el }
  let lastOverlayScan = 0;

  function overlayTextOk(t) {
    if (t.length < 3 || t.length > 240) return false;
    if (!/\p{L}{2,}/u.test(t) || OVERLAY_NOISE_RE.test(t) || SKIP.test(t)) return false;
    return isSpacelessScript(t) || splitWords(t).length >= 2;
  }

  // Widest ancestor that still looks like a caption window (small, no controls, no video)
  function overlayAnchor(el, root, vr) {
    let best = el;
    let cur = el.parentElement;
    for (let i = 0; cur && i < 4 && cur !== root; i++) {
      const r = cur.getBoundingClientRect();
      if (r.width > vr.width * 1.02 || r.height > vr.height * 0.6) break;
      if (cur.querySelector('video, ' + OVERLAY_INTERACTIVE)) break;
      best = cur;
      cur = cur.parentElement;
    }
    return best;
  }

  function sniffOverlay() {
    if (!videoEl) return null;
    const vr = videoEl.getBoundingClientRect();
    if (!(vr.width > 120 && vr.height > 80)) return null;
    const root = getSearchRoot(videoEl);
    let winner = null;
    const seen = new Set();
    for (const el of deepQueryAll(root, '*').slice(0, 3000)) {
      if (el === videoEl || GEN_BAD_TAG.has(String(el.tagName).toUpperCase())) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      own = norm(own);
      if (!overlayTextOk(own)) continue;
      const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
      if (GEN_EXCLUDE_RE.test(cls) || GEN_BAD_ROLE.test(el.getAttribute('role') || '')) continue;
      if (el.closest(OVERLAY_INTERACTIVE)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (!(r.width > 0 && r.height > 0 && cx >= vr.left && cx <= vr.right && cy >= vr.top + vr.height * 0.4 && cy <= vr.bottom)) continue;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) continue;

      const anchor = overlayAnchor(el, root, vr);
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      const text = collectText(anchor);
      if (!overlayTextOk(text)) continue;

      // Players may recreate the node for every cue, so statistics are keyed by position and class
      const ar = anchor.getBoundingClientRect();
      const sig = anchor.tagName + '|' + String(anchor.getAttribute('class') || '') + '|' + Math.round(((ar.top - vr.top) / vr.height) * 10);
      let st = overlayStats.get(sig);
      if (!st) overlayStats.set(sig, st = { texts: new Set(), el: anchor });
      st.el = anchor;
      st.texts.add(text);
      if (st.texts.size >= OVERLAY_MIN_CHANGES && (!winner || st.texts.size > winner.n)) winner = { el: anchor, n: st.texts.size };
    }
    if (overlayStats.size > 40) overlayStats.clear();
    return winner ? winner.el : null;
  }

  // Watchdog: tries file-based sources when live playback produces no text,
  // falls back to alternative sources if the current one stays silent,
  // and shows a hint when no subtitle source is found.
  function watchdog() {
    if (stopped || !videoEl) return;
    const now = Date.now();
    const playing = !videoEl.paused && !videoEl.ended;
    if (playing && lastWatchAt && !isAdPlaying()) playedMs += Math.min(now - lastWatchAt, 2000);
    lastWatchAt = now;

    // Try loading any newly discovered subtitle files
    if (!fileLoading && hasUntriedFiles()) {
      const noText = !gotText && attachedKind !== 'dom';
      if ((playing && now - initAt > 4000 && noText) || attachedKind === 'file') loadFileSource().catch(() => {});
    }

    // Attached to a DOM container that has not produced text yet: switch if a higher-priority container appears
    if (attachedKind === 'dom' && !gotText && now - lastDomRecheck > 2000) {
      lastDomRecheck = now;
      const better = findDom();
      if (better && better.container !== observedNode && better.container.isConnected) {
        detachSource();
        resetState();
        if (startObs(better)) { attachedKind = 'dom'; attachedAt = now; }
      }
    }

    // A known container stays silent while a text track is delivering cues: follow the track instead
    if (attachedKind === 'dom' && !gotText && playing && now - attachedAt > 5000) {
      const t = findTrack(videoEl);
      if (t && (t.mode === 'showing' || t.mode === 'hidden') && t.activeCues && t.activeCues.length) {
        detachSource();
        resetState();
        attachTrack(t);
        attachedKind = 'track';
        attachedAt = now;
        onCueChange();
      }
    }

    // Last resort: nothing has produced text yet while the video plays
    if (!gotText && playing && now - initAt > 8000 && attachedKind !== 'file' &&
        now - lastOverlayScan >= ((now - initAt > 60000) ? 3000 : 1000)) {
      lastOverlayScan = now;
      const el = sniffOverlay();
      if (el && el !== observedNode) {
        detachSource();
        resetState();
        if (startObs({ generic: true, container: el, root: null, c: null, t: null })) {
          attachedKind = 'generic';
          attachedAt = now;
        }
      }
    }

    if (!attachedKind) {
      // Some players only expose their subtitle tracks once playback has started, so the
      // captions hint is shown only after the video has played for a while without any source.
      if (hintStage < 1 && now - initAt > 3000) {
        hintStage = 1;
        showContent(null, null, 'Looking for subtitles\u2026', cfg.trackLang || '');
      } else if (hintStage < 2 && playedMs > 25000 && !fileLoading && !hasUntriedFiles()) {
        hintStage = 2;
        showContent(null, null, 'No subtitles detected \u2014 turn on captions (CC) in the player', cfg.trackLang || '');
      }
      return;
    }

    if (attachedKind !== 'dom' && attachedKind !== 'file' && !gotText && !fallbackTried && playing && now - attachedAt > 6000) {
      fallbackTried = true;
      const prev = attachedKind;
      detachSource();
      tryAttach(prev);
    }
  }

  // ── Initialisation and main polling loop ─────────────────────────────────────────
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
    initAt = Date.now();
    hintStage = 0; playedMs = 0; lastWatchAt = 0; fileTimeOffset = 0; adWas = false; genericCache = null; activationClicks = 0; overlayStats.clear();
    startResourceWatch();

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
      // Switch video target only if the current element disappears or a clearly larger one appears
      const switchVideo = currentVideo && currentVideo !== videoEl &&
        (!videoEl || !videoEl.isConnected || videoScore(currentVideo) > videoScore(videoEl) * 1.5);
      if (switchVideo) {
        detachSource();
        if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); }
        videoEl = currentVideo;
        if (videoEl) { videoEl.addEventListener('seeked', onSeeked); }
        applyVideoVolume(true);
        resetState();
        initAt = Date.now(); hintStage = 0; playedMs = 0; lastWatchAt = 0; fileTimeOffset = 0; adWas = false; genericCache = null; activationClicks = 0; overlayStats.clear();
      } else {
        applyVideoVolume(false);
      }

      if (!videoEl) return;
      ensureSubtitlesActive();
      attachSubtitles();
      watchdog();
    }, 1000);

    return { success: true };
  }

  function _cleanup() {
    stopped = true;
    if (bgSearch) { clearInterval(bgSearch); bgSearch = null; }
    if (obs) { obs.disconnect(); obs = null; }
    if (activeTrack) { activeTrack.removeEventListener('cuechange', onCueChange); activeTrack = null; }
    restoreTrackMode();
    if (videoEl) { videoEl.removeEventListener('seeked', onSeeked); videoEl = null; }
    const s = document.getElementById('stts-hide-cc');
    if (s) s.remove();
    restoreInlineHide();
    stopFileDriver();
    stopResourceWatch();
    fileCands.clear(); fileTried.clear(); fileTracks = []; fileLoading = false;
    restoreCtrl();
    restoreVideoVolume();
    resetState();
    activeSel = null;
    observedNode = null;
    attachedKind = '';
    genericCache = null;
    overlayStats.clear();
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
      case 'SUBTITLE_TTS_DETACH':
        _cleanup();
        res({ success: true });
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

  return { reinit: (s) => init(s), stop, _cleanup, probe, diagnose };
})();
