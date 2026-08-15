const STORAGE_KEY = 'sara_voice_out';

export function isVoiceOutEnabled() {
  try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
}

export function setVoiceOutEnabled(enabled) {
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch {}
  if (!enabled) window.speechSynthesis?.cancel();
}

// iOS Safari requires a user gesture before speechSynthesis works.
// We "unlock" it on the first tap by speaking a silent utterance.
// The utterance must NOT be empty — iOS drops a zero-length one without queueing it,
// so the unlock appears to happen and every later speak() is silently ignored. A single
// space at volume 0 is inaudible everywhere and actually unlocks.
let unlocked = false;
export function unlockAudio() {
  if (unlocked || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  unlocked = true;
}
export function isAudioUnlocked() { return unlocked; }
if (typeof document !== 'undefined') {
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });
}

// Chrome/Windows lazily loads voices — cache after voiceschanged fires
let cachedVoice = null;
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; };
}

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  // iOS: Samantha (default), Martha/Kate (en-GB)
  // Chrome: Google UK English Female
  // Windows: Libby, Sonia, Maisie (neural), Hazel (legacy)
  // macOS: Moira, Fiona (en-GB/en-IE)
  cachedVoice = voices.find(v => /google.*uk.*female/i.test(v.name))
    || voices.find(v => /martha/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /kate/i.test(v.name) && /en-AU/i.test(v.lang))
    || voices.find(v => /libby/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /sonia/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /maisie/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /hazel/i.test(v.name) && /en-GB/i.test(v.lang))
    || voices.find(v => /moira|fiona/i.test(v.name) && /en/i.test(v.lang))
    || voices.find(v => /en-GB/i.test(v.lang) && !/male/i.test(v.name))
    || voices.find(v => /en-GB/i.test(v.lang))
    || null;
  if (cachedVoice) console.log(`[SARA Voice] Selected: ${cachedVoice.name} (${cachedVoice.lang})`);
  else console.warn('[SARA Voice] No suitable voice found', voices.map(v => `${v.name} [${v.lang}]`));
  return cachedVoice;
}

function cleanText(text) {
  return text
    .replace(/\[.*?\]/g, '')
    .replace(/[#*_`>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

// Returns the utterance so callers can watch onstart/onerror, or null if it bailed.
export function speakSara(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const synth = window.speechSynthesis;
  // Only cancel when there is something to cancel — an unconditional cancel() straight
  // before speak() is one of the ways iOS ends up stuck with nothing coming out.
  if (synth.speaking || synth.pending) synth.cancel();
  // iOS can leave the queue paused after a backgrounded tab or a finished utterance;
  // resume() is a no-op when it isn't.
  synth.resume();
  const clean = cleanText(text);
  if (!clean) return null;
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
  return utterance;
}

export function speakIfEnabled(text) {
  if (isVoiceOutEnabled()) speakSara(text);
}
