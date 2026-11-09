// Spoken commands: hold to talk, Whisper on this computer writes it down (the server's
// /api/transcribe), and the words become a command: "set H to 50", "increase slab T by 2",
// "rebalance", "push", "pull", "tap", "undo", "redo", "stop".

/** Hold to talk: start() opens the microphone and records; stop() resolves to the recording. */
export function createRecorder() {
  let rec = null, chunks = [], stream = null;
  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('this browser cannot record sound');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.start();
    },
    async stop() {
      if (!rec) return null;
      const r = rec;
      rec = null;
      const done = new Promise(resolve => { r.onstop = resolve; });
      r.stop();
      await done;
      stream.getTracks().forEach(t => t.stop());
      return new Blob(chunks, { type: r.mimeType || 'audio/webm' });
    },
    recording: () => !!rec,
  };
}

/** Start Whisper now, so the first command does not wait for the model to load. */
export function warmUp() { fetch('/api/transcribe/warm', { method: 'POST' }).catch(() => {}); }

/** What was said in `blob`; `words` (variable names, commands) steer Whisper's spelling. */
export async function transcribe(blob, words = []) {
  const prompt = `Commands like: set H to 50, increase slabT by 2, carve the solid slab, rebalance, push, pull, tap, undo. Names: ${words.join(', ')}.`;
  const r = await fetch(`/api/transcribe?type=${encodeURIComponent(blob.type)}&prompt=${encodeURIComponent(prompt)}`, { method: 'POST', body: blob });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return (await r.json()).text;
}

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
                twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** A number at the end of `s`, in digits or words ("fifty two point five"), or null. */
function number(s) {
  const d = s.match(/(-?\d+(?:[.,]\d+)?)\s*(?:mm|millimet(?:er|re)s?)?\s*$/);
  if (d) return +d[1].replace(',', '.');
  const words = s.trim().split(/[\s-]+/);
  let i = words.length, frac = '';
  const pt = words.lastIndexOf('point');
  if (pt >= 0) { frac = words.slice(pt + 1).map(w => SMALL[w]).join(''); if (/NaN|undefined/.test(frac)) return null; i = pt; }
  let n = null;
  for (const w of words.slice(0, i)) {
    if (w in SMALL) n = (n ?? 0) + SMALL[w];
    else if (w in TENS) n = (n ?? 0) + TENS[w];
    else if (w === 'hundred') n = (n || 1) * 100;
    else if (n != null) return null;
  }
  return n == null ? null : +(frac ? `${n}.${frac}` : n);
}

// a letter as Whisper may write it out, and the words short names abbreviate ("truss height" is trussH)
const LETTERS = { age: 'h', aitch: 'h', each: 'h', bee: 'b', be: 'b', tea: 't', tee: 't', ef: 'f', double: 'w', you: 'u',
                  height: 'h', depth: 'h', thickness: 't', thick: 't', width: 'w', wide: 'w' };
const squash = s => s.toLowerCase().split(/\s+/).map(w => LETTERS[w] ?? w).join('').replace(/[^a-z0-9]/g, '');

/** The variable `phrase` names, if one does (spoken "slab T" is slabT). */
function variable(phrase, names) {
  const p = squash(phrase.replace(/^(the|a)\s+/, ''));
  return names.find(n => squash(n) === p) ?? null;
}

const NUMWORD = new Set([...Object.keys(SMALL), ...Object.keys(TENS), 'hundred', 'point']);
const isNum = w => /^-?\d+(?:[.,]\d+)?$/.test(w) || NUMWORD.has(w);
const UP = /\b(increase|increased|raise|grow|add|plus|more|bigger|larger|thicker|wider|deeper|taller|higher|up)\b/;
const DOWN = /\b(decrease|decreased|reduce|lower|shrink|minus|less|smaller|thinner|narrower|shallower|shorter|down|subtract)\b/;

/** The variable named somewhere in `words` (the longest run of up to 3 words that squashes to one). */
function findVariable(words, names) {
  for (let len = 3; len >= 1; len--)
    for (let i = 0; i + len <= words.length; i++) {
      const span = words.slice(i, i + len);
      if (span.some(isNum) && len > 1) continue;
      const n = variable(span.join(' '), names);
      if (n) return n;
    }
  return null;
}

/** The last number said in `words`, in digits or words. */
function lastNumber(words) {
  let end = -1;
  for (let i = words.length - 1; i >= 0; i--) if (isNum(words[i])) { end = i; break; }
  if (end < 0) return null;
  let start = end;
  while (start > 0 && isNum(words[start - 1])) start--;
  return number(words.slice(start, end + 1).join(' '));
}

/** The part named in `text`: "the solid slab", "the girder", "C". */
function findBody(text, bodies) {
  for (const b of bodies) {
    const label = b.name.toLowerCase().replace(/^[a-z]\s*·\s*/, '');
    const keys = label.split(/[\s-]+/).filter(w => w.length > 3);
    if (text.includes(label) || keys.some(k => new RegExp('\\b' + k).test(text))) return b.id;
  }
  return null;
}

/**
 * The command in `text`, found by keywords wherever they are in the sentence:
 * { type: 'set', values } | { type: 'carve', body, keep } | { type: 'rebalance' | 'undo' |
 * 'redo' | 'stop' } | { type: 'mode', mode: 'push' | 'pull' | 'tap' } | null. `current`
 * gives the values a relative change adds to; `bodies` [{ id, name }] the parts to name.
 */
export function command(text, names, current, bodies = []) {
  const t = text.toLowerCase().replace(/[“”"!?]/g, '').replace(/[.,;:](?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  if (/\bundo\b|\btake (that|it) back\b|\bgo back\b/.test(t)) return { type: 'undo' };
  if (/\bredo\b/.test(t)) return { type: 'redo' };
  if (/^(stop|cancel|halt)\b|\bstop it\b/.test(t)) return { type: 'stop' };
  if (/\b(carve|carved|carving|topology|hollow)\b/.test(t)) {
    const pct = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/);
    return { type: 'carve', body: findBody(t, bodies), keep: pct ? +pct[1] / 100 : null };
  }
  if (/\b(re-?balance|balance|optimi[sz]e|auto)\b/.test(t)) return { type: 'rebalance' };
  const name = findVariable(words, names), v = lastNumber(words);
  if (name && v != null) {
    // "by", or a word for more or less without "to": a change; otherwise the new value
    const relative = (/\bby\b/.test(t) || UP.test(t) || DOWN.test(t)) && !/\bto\b/.test(t);
    if (!relative) return { type: 'set', values: { [name]: v } };
    const sign = DOWN.test(t) ? -1 : 1;
    return { type: 'set', values: { [name]: +(current[name] + sign * v).toFixed(6) } };
  }
  const m = t.match(/\b(push|pull|tap)\b/);
  if (m) return { type: 'mode', mode: m[1] };
  return null;
}
