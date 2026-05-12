/*
 * popup.js — part of Audio Transcription
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

const DEFAULTS = {
  serverHost:'localhost', serverPort:'9090',
  selectedLanguage:'', selectedTask:'transcribe', selectedModelSize:'small',
  textFormatting:'advanced', transcriptionProfile:'balanced', hideLiveText:false,
  geminiApiKey:'', geminiModel:'gemini-3.1-flash-lite-preview',
  targetLanguage:'es', displayMode:'both',
  useVad:true, useStandalone:false,
  enableTts:false, ttsSpeed:'1.2',
  enableGeminiTranslation:false,
  subtitlePlaybackControl:'pause', subtitleSlowdownRate:'0.8',
  subtitleVideoVolume:'1.0',
  activeTab:'subtitle'
};

const el = {};
let fullApiKey = '';
let fullWlApiKey = '';

function $(id){ return document.getElementById(id); }

// Tab switching
function switchTab(tabName) {
  ['subtitle','whisper'].forEach(t => {
    $('tabBtn' + t.charAt(0).toUpperCase() + t.slice(1))?.classList.toggle('active', t === tabName);
    $('panel' + t.charAt(0).toUpperCase() + t.slice(1))?.classList.toggle('active', t === tabName);
  });
  chrome.storage.local.set({ activeTab: tabName });
}

// Sync duplicate TTS/Translation controls
const SYNC_PAIRS = [
  ['ttsSpeed',                    'wl_ttsSpeed'],
  ['enableTtsCheckbox',           'wl_enableTtsCheckbox'],
  ['enableGeminiTranslationCheckbox','wl_enableGeminiTranslationCheckbox'],
  ['geminiModelDropdown',         'wl_geminiModelDropdown'],
  ['targetLanguageDropdown',      'wl_targetLanguageDropdown'],
  ['stts_displayModeDropdown',    'displayModeDropdown'],
  ['stts_useStandaloneCheckbox',  'useStandaloneCheckbox']
];

function syncFrom(sourceId, targetId) {
  const src = $(sourceId), tgt = $(targetId);
  if (!src || !tgt) return;
  if (src.type === 'checkbox') { tgt.checked = src.checked; }
  else { tgt.value = src.value; }
}

function bindSync(id1, id2) {
  const e1 = $(id1), e2 = $(id2);
  if (!e1 || !e2) return;
  const ev = (e1.type === 'checkbox' || e1.tagName === 'SELECT') ? 'change' : 'input';
  e1.addEventListener(ev, () => syncFrom(id1, id2));
  e2.addEventListener(ev, () => syncFrom(id2, id1));
}

// Element references
function initElements() {
  el.startSubtitleTtsButton = $('startSubtitleTts');
  el.stopSubtitleTtsButton  = $('stopSubtitleTts');
  el.subtitleTtsStatus      = $('subtitleTtsStatus');
  el.subtitlePlaybackControl= $('subtitlePlaybackControl');
  el.subtitleSlowdownRate   = $('subtitleSlowdownRate');
  el.subtitleSlowdownRateValue=$('subtitleSlowdownRateValue');
  el.subtitleSlowdownRow    = $('subtitleSlowdownRow');
  el.subtitleVideoVolume    = $('subtitleVideoVolume');
  el.subtitleVideoVolumeValue = $('subtitleVideoVolumeValue');
  el.stts_displayModeDropdown = $('stts_displayModeDropdown');
  el.stts_useStandaloneCheckbox = $('stts_useStandaloneCheckbox');
  el.ttsSpeed               = $('ttsSpeed');
  el.ttsSpeedValue          = $('ttsSpeedValue');
  el.enableTtsCheckbox      = $('enableTtsCheckbox');
  el.hideNativeSubtitles    = $('hideNativeSubtitles');
  el.enableGeminiTranslationCheckbox = $('enableGeminiTranslationCheckbox');
  el.geminiApiKey           = $('geminiApiKey');
  el.geminiApiKeyRow        = $('geminiApiKeyRow');
  el.geminiModelDropdown    = $('geminiModelDropdown');
  el.targetLanguageDropdown = $('targetLanguageDropdown');
  el.startButton            = $('startCapture');
  el.stopButton             = $('stopCapture');
  el.connectionStatus       = $('connectionStatus');
  el.ipAddress              = $('ipAddress');
  el.port                   = $('port');
  el.defaultIpButton        = $('defaultIpButton');
  el.languageDropdown       = $('languageDropdown');
  el.taskDropdown           = $('taskDropdown');
  el.modelSizeDropdown      = $('modelSizeDropdown');
  el.transcriptionProfileDropdown=$('transcriptionProfileDropdown');
  el.textFormattingDropdown = $('textFormattingDropdown');
  el.displayModeDropdown    = $('displayModeDropdown');
  el.hideLiveTextCheckbox   = $('hideLiveTextCheckbox');
  el.useStandaloneCheckbox  = $('useStandaloneCheckbox');
  el.useVadCheckbox         = $('useVadCheckbox');
  el.wl_ttsSpeed            = $('wl_ttsSpeed');
  el.wl_ttsSpeedValue       = $('wl_ttsSpeedValue');
  el.wl_enableTtsCheckbox   = $('wl_enableTtsCheckbox');
  el.wl_enableGeminiTranslationCheckbox=$('wl_enableGeminiTranslationCheckbox');
  el.wl_geminiApiKey        = $('wl_geminiApiKey');
  el.wl_geminiApiKeyRow     = $('wl_geminiApiKeyRow');
  el.wl_geminiModelDropdown = $('wl_geminiModelDropdown');
  el.wl_targetLanguageDropdown=$('wl_targetLanguageDropdown');
  el.wl_videoVolume         = $('wl_videoVolume');
  el.wl_videoVolumeValue    = $('wl_videoVolumeValue');
}

// Normalizers
function normalizeHost(v){ return String(v||'').trim()||DEFAULTS.serverHost; }
function normalizePort(v){ return String(v||'').replace(/\D/g,'')||DEFAULTS.serverPort; }
function normalizeSpeed(v){ const n=parseFloat(v); return isFinite(n)?Math.min(2,Math.max(.5,n)).toFixed(1):DEFAULTS.ttsSpeed; }
function normalizeRate(v,mn,mx,def){ const n=parseFloat(v); return isFinite(n)?Math.min(mx,Math.max(mn,n)).toFixed(1):def; }
function maskApiKey(k){ if(!k) return ''; if(k.length<=6) return '•'.repeat(k.length); return k.slice(0,3)+'•'.repeat(Math.min(k.length-6,24))+k.slice(-3); }

// Status helpers
function setStatus(t){ if(el.connectionStatus) el.connectionStatus.textContent=t; }
function setButtonsFromState(active){ el.startButton&&(el.startButton.disabled=!!active); el.stopButton&&(el.stopButton.disabled=!active); setStatus(active?'Capturing...':'Idle'); }
function setSubtitleStatus(t){ if(el.subtitleTtsStatus) el.subtitleTtsStatus.textContent=t; }
function setSubtitleButtonsFromState(active){ el.startSubtitleTtsButton&&(el.startSubtitleTtsButton.disabled=!!active); el.stopSubtitleTtsButton&&(el.stopSubtitleTtsButton.disabled=!active); setSubtitleStatus(active?'Active':'Idle'); }

// UI helpers
function updateApiKeyVisibility(){
  const isGT = (el.geminiModelDropdown?.value==='google-translate');
  if(el.geminiApiKeyRow) el.geminiApiKeyRow.style.display=isGT?'none':'';
  if(el.wl_geminiApiKeyRow) el.wl_geminiApiKeyRow.style.display=isGT?'none':'';
}
function updateTtsSpeedLabel(){ const s=normalizeSpeed(el.ttsSpeed?.value); if(el.ttsSpeed) el.ttsSpeed.value=s; if(el.ttsSpeedValue) el.ttsSpeedValue.textContent=s+'x'; }
function updateWlTtsSpeedLabel(){ const s=normalizeSpeed(el.wl_ttsSpeed?.value); if(el.wl_ttsSpeed) el.wl_ttsSpeed.value=s; if(el.wl_ttsSpeedValue) el.wl_ttsSpeedValue.textContent=s+'x'; }
function updateSlowdownVisibility(){ const on=el.subtitlePlaybackControl?.value==='slowdown'; if(el.subtitleSlowdownRow) el.subtitleSlowdownRow.style.display=on?'':'none'; }
function updateSlowdownRateLabel(){ const r=normalizeRate(el.subtitleSlowdownRate?.value,.3,.9,DEFAULTS.subtitleSlowdownRate); if(el.subtitleSlowdownRate) el.subtitleSlowdownRate.value=r; if(el.subtitleSlowdownRateValue) el.subtitleSlowdownRateValue.textContent=r+'x'; }
function updateVideoVolumeLabelUI(){ 
  const v=parseFloat(el.subtitleVideoVolume?.value??'1'); 
  const pct=Math.round(v*100)+'%'; 
  if(el.subtitleVideoVolumeValue) el.subtitleVideoVolumeValue.textContent=pct;
  if(el.wl_videoVolumeValue) el.wl_videoVolumeValue.textContent=pct;
}

// Collect / Save / Apply
function collectSettings(){
  return {
    serverHost: normalizeHost(el.ipAddress?.value),
    serverPort: normalizePort(el.port?.value),
    selectedLanguage: el.languageDropdown?.value||'',
    selectedTask: el.taskDropdown?.value||DEFAULTS.selectedTask,
    selectedModelSize: el.modelSizeDropdown?.value||DEFAULTS.selectedModelSize,
    textFormatting: el.textFormattingDropdown?.value||DEFAULTS.textFormatting,
    transcriptionProfile: el.transcriptionProfileDropdown?.value||DEFAULTS.transcriptionProfile,
    hideLiveText: !!el.hideLiveTextCheckbox?.checked,
    geminiApiKey: fullApiKey,
    geminiModel: el.geminiModelDropdown?.value||DEFAULTS.geminiModel,
    targetLanguage: el.targetLanguageDropdown?.value||DEFAULTS.targetLanguage,
    displayMode: el.displayModeDropdown?.value||DEFAULTS.displayMode,
    useVad: !!el.useVadCheckbox?.checked,
    useStandalone: !!el.useStandaloneCheckbox?.checked,
    enableTts: !!el.enableTtsCheckbox?.checked,
    ttsSpeed: normalizeSpeed(el.ttsSpeed?.value),
    enableGeminiTranslation: !!el.enableGeminiTranslationCheckbox?.checked,
    subtitlePlaybackControl: el.subtitlePlaybackControl?.value||DEFAULTS.subtitlePlaybackControl,
    subtitleSlowdownRate: normalizeRate(el.subtitleSlowdownRate?.value,.3,.9,DEFAULTS.subtitleSlowdownRate),
    subtitleVideoVolume: String(parseFloat(el.subtitleVideoVolume?.value??'1').toFixed(2)),
    hideNativeSubtitles: el.hideNativeSubtitles ? !!el.hideNativeSubtitles.checked : true
  };
}

async function saveSettings(){
  const s=collectSettings();
  await chrome.storage.local.set({
    serverHost:s.serverHost, serverPort:s.serverPort,
    ipAddress:s.serverHost, port:s.serverPort,
    selectedLanguage:s.selectedLanguage||null,
    selectedTask:s.selectedTask, selectedModelSize:s.selectedModelSize,
    textFormatting:s.textFormatting, transcriptionProfile:s.transcriptionProfile,
    hideLiveText:s.hideLiveText, geminiApiKey:s.geminiApiKey,
    geminiModel:s.geminiModel, targetLanguage:s.targetLanguage,
    displayMode:s.displayMode, useVad:s.useVad, useStandalone:s.useStandalone,
    enableTts:s.enableTts, ttsSpeed:s.ttsSpeed,
    enableGeminiTranslation:s.enableGeminiTranslation,
    subtitlePlaybackControl:s.subtitlePlaybackControl,
    subtitleSlowdownRate:s.subtitleSlowdownRate,
    subtitleVideoVolume:s.subtitleVideoVolume,
    hideNativeSubtitles:s.hideNativeSubtitles
  });
  return s;
}

function applySettingsToUI(s){
  if(el.ipAddress) el.ipAddress.value=s.serverHost??DEFAULTS.serverHost;
  if(el.port) el.port.value=s.serverPort??DEFAULTS.serverPort;
  if(el.languageDropdown) el.languageDropdown.value=s.selectedLanguage??'';
  if(el.taskDropdown) el.taskDropdown.value=s.selectedTask??DEFAULTS.selectedTask;
  if(el.modelSizeDropdown) el.modelSizeDropdown.value=s.selectedModelSize??DEFAULTS.selectedModelSize;
  if(el.textFormattingDropdown) el.textFormattingDropdown.value=s.textFormatting??DEFAULTS.textFormatting;
  if(el.transcriptionProfileDropdown) el.transcriptionProfileDropdown.value=s.transcriptionProfile??DEFAULTS.transcriptionProfile;
  if(el.hideLiveTextCheckbox) el.hideLiveTextCheckbox.checked=s.hideLiveText??false;
  if(el.displayModeDropdown) el.displayModeDropdown.value=s.displayMode??DEFAULTS.displayMode;
  if(el.stts_displayModeDropdown) el.stts_displayModeDropdown.value=s.displayMode??DEFAULTS.displayMode;
  if(el.useVadCheckbox) el.useVadCheckbox.checked=s.useVad??true;
  if(el.useStandaloneCheckbox) el.useStandaloneCheckbox.checked=s.useStandalone??false;
  if(el.stts_useStandaloneCheckbox) el.stts_useStandaloneCheckbox.checked=s.useStandalone??false;
  if(el.hideNativeSubtitles) el.hideNativeSubtitles.checked=s.hideNativeSubtitles??true;

  const speed=normalizeSpeed(s.ttsSpeed??DEFAULTS.ttsSpeed);
  if(el.ttsSpeed) el.ttsSpeed.value=speed;
  if(el.wl_ttsSpeed) el.wl_ttsSpeed.value=speed;
  if(el.enableTtsCheckbox) el.enableTtsCheckbox.checked=s.enableTts??false;
  if(el.wl_enableTtsCheckbox) el.wl_enableTtsCheckbox.checked=s.enableTts??false;

  fullApiKey=String(s.geminiApiKey??'');
  fullWlApiKey=fullApiKey;
  if(el.geminiApiKey) el.geminiApiKey.value=maskApiKey(fullApiKey);
  if(el.wl_geminiApiKey) el.wl_geminiApiKey.value=maskApiKey(fullApiKey);
  const gm=s.geminiModel??DEFAULTS.geminiModel;
  if(el.geminiModelDropdown) el.geminiModelDropdown.value=gm;
  if(el.wl_geminiModelDropdown) el.wl_geminiModelDropdown.value=gm;
  const tl=s.targetLanguage??DEFAULTS.targetLanguage;
  if(el.targetLanguageDropdown) el.targetLanguageDropdown.value=tl;
  if(el.wl_targetLanguageDropdown) el.wl_targetLanguageDropdown.value=tl;
  const ge=s.enableGeminiTranslation??false;
  if(el.enableGeminiTranslationCheckbox) el.enableGeminiTranslationCheckbox.checked=ge;
  if(el.wl_enableGeminiTranslationCheckbox) el.wl_enableGeminiTranslationCheckbox.checked=ge;

  if(el.subtitlePlaybackControl) el.subtitlePlaybackControl.value=s.subtitlePlaybackControl??DEFAULTS.subtitlePlaybackControl;
  if(el.subtitleSlowdownRate) el.subtitleSlowdownRate.value=normalizeRate(s.subtitleSlowdownRate??DEFAULTS.subtitleSlowdownRate,.3,.9,DEFAULTS.subtitleSlowdownRate);
  const vol=parseFloat(s.subtitleVideoVolume??DEFAULTS.subtitleVideoVolume).toFixed(2);
  if(el.subtitleVideoVolume) el.subtitleVideoVolume.value=vol;
  if(el.wl_videoVolume) el.wl_videoVolume.value=vol;

  updateTtsSpeedLabel(); updateWlTtsSpeedLabel();
  updateSlowdownRateLabel(); updateSlowdownVisibility();
  updateVideoVolumeLabelUI();
  updateApiKeyVisibility();
}

async function loadSettings(){
  const stored=await chrome.storage.local.get(null);
  const s={
    ...DEFAULTS,...stored,
    serverHost:stored.serverHost||stored.ipAddress||DEFAULTS.serverHost,
    serverPort:stored.serverPort||stored.port||DEFAULTS.serverPort,
    selectedLanguage:(stored.selectedLanguage===undefined||stored.selectedLanguage===null)?'':stored.selectedLanguage
  };
  applySettingsToUI(s);
  setButtonsFromState(!!stored?.capturingState?.isCapturing||!!stored?.isCapturing);
  setSubtitleButtonsFromState(!!stored?.isSubtitleTtsActive);
  switchTab(stored.activeTab||'subtitle');
}

// Actions
async function getActiveTab(){ const t=await chrome.tabs.query({active:true,currentWindow:true}); return t&&t.length?t[0]:null; }

async function startCapture(){
  const s=await saveSettings(), tab=await getActiveTab();
  if(!tab?.id){ setButtonsFromState(false); setStatus('No active tab'); return; }
  setStatus('Starting...');
  chrome.runtime.sendMessage({action:'startCapture',tabId:tab.id,host:s.serverHost,port:s.serverPort,useMultilingual:!s.selectedLanguage,useVad:s.useVad,useStandalone:s.useStandalone},(r)=>{ if(chrome.runtime.lastError||!r?.success){setButtonsFromState(false);setStatus('Start failed');} });
}

function stopCapture(){
  setStatus('Stopping...');
  chrome.runtime.sendMessage({action:'stopCapture'},(r)=>{ if(chrome.runtime.lastError||!r?.success) setStatus('Stop failed'); });
}

async function startSubtitleTts(){
  await saveSettings(); const tab=await getActiveTab();
  if(!tab?.id){ setSubtitleStatus('No active tab'); return; }
  setSubtitleStatus('Starting...');
  chrome.runtime.sendMessage({action:'startSubtitleTts',tabId:tab.id},(r)=>{
    if(chrome.runtime.lastError||!r?.success){ setSubtitleButtonsFromState(false); setSubtitleStatus(r?.error||'Start failed'); return; }
    setSubtitleButtonsFromState(true);
  });
}

function stopSubtitleTts(){
  setSubtitleStatus('Stopping...');
  chrome.runtime.sendMessage({action:'stopSubtitleTts'},(r)=>{ if(chrome.runtime.lastError||!r?.success){setSubtitleStatus('Stop failed');return;} setSubtitleButtonsFromState(false); });
}

async function resetDefaults(){
  await chrome.storage.local.set({serverHost:DEFAULTS.serverHost,serverPort:DEFAULTS.serverPort,ipAddress:DEFAULTS.serverHost,port:DEFAULTS.serverPort});
  if(el.ipAddress) el.ipAddress.value=DEFAULTS.serverHost;
  if(el.port) el.port.value=DEFAULTS.serverPort;
}

// Autosave bindings
function bindAutosave(){
  SYNC_PAIRS.forEach(([a,b])=>bindSync(a,b));

  const ctrls=[
    el.enableTtsCheckbox, el.enableGeminiTranslationCheckbox,
    el.useStandaloneCheckbox, el.useVadCheckbox, el.hideLiveTextCheckbox,
    el.ipAddress, el.port, el.languageDropdown, el.taskDropdown,
    el.modelSizeDropdown, el.textFormattingDropdown, el.transcriptionProfileDropdown,
    el.geminiModelDropdown, el.targetLanguageDropdown, el.displayModeDropdown,
    el.subtitlePlaybackControl, el.hideNativeSubtitles,
    el.wl_enableTtsCheckbox, el.wl_enableGeminiTranslationCheckbox,
    el.wl_geminiModelDropdown, el.wl_targetLanguageDropdown,
    el.stts_displayModeDropdown, el.stts_useStandaloneCheckbox
  ].filter(Boolean);

  for(const c of ctrls){
    const ev=(c.tagName==='INPUT'&&(c.type==='text'||c.type==='number'))?'input':'change';
    c.addEventListener(ev,async()=>saveSettings());
    if(ev!=='change') c.addEventListener('change',async()=>saveSettings());
  }

  [['ttsSpeed',updateTtsSpeedLabel],['wl_ttsSpeed',updateWlTtsSpeedLabel]].forEach(([id,fn])=>{
    const e=$(id); if(!e) return;
    e.addEventListener('input',async()=>{fn();syncFrom(id,id==='ttsSpeed'?'wl_ttsSpeed':'ttsSpeed');updateWlTtsSpeedLabel();updateTtsSpeedLabel();await saveSettings();});
    e.addEventListener('change',async()=>{fn();await saveSettings();});
  });

  if(el.subtitleSlowdownRate){
    el.subtitleSlowdownRate.addEventListener('input',async()=>{updateSlowdownRateLabel();await saveSettings();});
    el.subtitleSlowdownRate.addEventListener('change',async()=>saveSettings());
  }
  if(el.subtitleVideoVolume){
    el.subtitleVideoVolume.addEventListener('input',async()=>{
      if(el.wl_videoVolume) el.wl_videoVolume.value = el.subtitleVideoVolume.value;
      updateVideoVolumeLabelUI();
      await saveSettings();
    });
    el.subtitleVideoVolume.addEventListener('change',async()=>saveSettings());
  }
  if(el.wl_videoVolume){
    el.wl_videoVolume.addEventListener('input',async()=>{
      if(el.subtitleVideoVolume) el.subtitleVideoVolume.value = el.wl_videoVolume.value;
      updateVideoVolumeLabelUI();
      await saveSettings();
    });
    el.wl_videoVolume.addEventListener('change',async()=>saveSettings());
  }
  if(el.subtitlePlaybackControl) el.subtitlePlaybackControl.addEventListener('change',updateSlowdownVisibility);

  if(el.geminiApiKey){
    el.geminiApiKey.addEventListener('focus',()=>{ el.geminiApiKey.value=fullApiKey; });
    el.geminiApiKey.addEventListener('input',()=>{ fullApiKey=el.geminiApiKey.value; fullWlApiKey=fullApiKey; if(el.wl_geminiApiKey) el.wl_geminiApiKey.value=maskApiKey(fullApiKey); });
    el.geminiApiKey.addEventListener('blur',async()=>{ fullApiKey=String(el.geminiApiKey.value||'').trim(); el.geminiApiKey.value=maskApiKey(fullApiKey); fullWlApiKey=fullApiKey; if(el.wl_geminiApiKey) el.wl_geminiApiKey.value=maskApiKey(fullApiKey); await saveSettings(); });
  }
  if(el.wl_geminiApiKey){
    el.wl_geminiApiKey.addEventListener('focus',()=>{ el.wl_geminiApiKey.value=fullWlApiKey; });
    el.wl_geminiApiKey.addEventListener('input',()=>{ fullWlApiKey=el.wl_geminiApiKey.value; fullApiKey=fullWlApiKey; if(el.geminiApiKey) el.geminiApiKey.value=maskApiKey(fullApiKey); });
    el.wl_geminiApiKey.addEventListener('blur',async()=>{ fullWlApiKey=String(el.wl_geminiApiKey.value||'').trim(); el.wl_geminiApiKey.value=maskApiKey(fullWlApiKey); fullApiKey=fullWlApiKey; if(el.geminiApiKey) el.geminiApiKey.value=maskApiKey(fullApiKey); await saveSettings(); });
  }

  if(el.languageDropdown){
    el.languageDropdown.addEventListener('change',()=>{
      chrome.runtime.sendMessage({action:'updateSelectedLanguage',detectedLanguage:el.languageDropdown.value||null},()=>void chrome.runtime.lastError);
    });
  }
  if(el.geminiModelDropdown) el.geminiModelDropdown.addEventListener('change',updateApiKeyVisibility);
  if(el.wl_geminiModelDropdown) el.wl_geminiModelDropdown.addEventListener('change',updateApiKeyVisibility);
}

// Button bindings
function bindButtons(){
  el.startButton?.addEventListener('click',startCapture);
  el.stopButton?.addEventListener('click',stopCapture);
  el.defaultIpButton?.addEventListener('click',resetDefaults);
  el.startSubtitleTtsButton?.addEventListener('click',startSubtitleTts);
  el.stopSubtitleTtsButton?.addEventListener('click',stopSubtitleTts);
  $('tabBtnSubtitle')?.addEventListener('click',()=>switchTab('subtitle'));
  $('tabBtnWhisper')?.addEventListener('click',()=>switchTab('whisper'));
}

// Runtime messages
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  try{
    if(msg.action==='toggleCaptureButtons'){ setButtonsFromState(!!msg.isCapturing); sendResponse({success:true}); return false; }
    if(msg.action==='updateSelectedLanguage'&&el.languageDropdown){ el.languageDropdown.value=msg.detectedLanguage||''; sendResponse({success:true}); return false; }
    if(msg.action==='subtitleTtsStateChanged'){ setSubtitleButtonsFromState(!!msg.isActive); sendResponse({success:true}); return false; }
    return false;
  }catch(e){ return false; }
});

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local') return;
  if(changes.capturingState||changes.isCapturing){
    chrome.storage.local.get(['capturingState','isCapturing'],res=>setButtonsFromState(!!res?.capturingState?.isCapturing||!!res?.isCapturing));
  }
  if(changes.isSubtitleTtsActive) setSubtitleButtonsFromState(!!changes.isSubtitleTtsActive.newValue);
});

// Init
document.addEventListener('DOMContentLoaded',async()=>{
  initElements();

  const vEl=$('extensionVersion');
  if(vEl){ const v=chrome.runtime.getManifest?.()?.version||''; if(v) vEl.textContent='v. '+v; }

  await loadSettings();
  bindAutosave();
  bindButtons();
  updateTtsSpeedLabel();
  updateWlTtsSpeedLabel();
  updateSlowdownRateLabel();
  updateSlowdownVisibility();
});
