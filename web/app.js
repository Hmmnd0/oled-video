import { createEditor } from './editor.js';
// Video -> OLED: plays a video (file, YouTube, or a captured tab) with its sound in
// the browser, and streams every frame to the ESP32-C3 shrunk to 72x40.
// The board runs the firmware in ../firmware, which takes frames over USB:
//   0xA5 0x5A + 360 bytes          1-bit frame
//   0xA5 0x5B + flags + 720 bytes  4-grey frame (low plane, high plane)
const OW = 72, OH = 40, PLANE = OW * OH / 8;
const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const defaults = { v: 1, fit: 'crop', pan: 50, shades: 2, dither: 'atkinson', brightness: 0, contrast: 1.2, gamma: 1, sharpen: 0.6, invert: false };
let settings = { ...defaults };
try { const s = JSON.parse(localStorage.getItem('video-oled-settings')); if (s?.v === 1) settings = { ...defaults, ...s }; } catch {}
const persist = () => { try { localStorage.setItem('video-oled-settings', JSON.stringify(settings)); } catch {} };

// ---------- sources ----------
// source = { kind: 'file'|'youtube'|'capture', el: HTMLVideoElement (what we read pixels from) }
let source = null;
const stage = $('stage');

function clearStage() {
  if (source?.stream) source.stream.getTracks().forEach((t) => t.stop());
  if (source?.url) URL.revokeObjectURL(source.url);
  source = null;
  [...stage.querySelectorAll('video, iframe, canvas')].forEach((e) => e.remove());
  $('drop').style.display = 'none';
}

const NATIVE = /\.(mp4|m4v|webm|mov|ogv)$/i;

// Files go into the editor: each one becomes a clip on the timeline, and the stage
// shows the edit (drawn on the editor's canvas, which the OLED pipeline reads)
async function openFiles(list) {
  const fl = [...list].filter(Boolean);
  if (!fl.length) return;
  showEditor();
  await editor.addFiles(fl);
  $('sourceText').textContent = 'Edit';
  $('sourceNote').textContent = 'Sound plays here in the browser; the picture goes to the OLED in sync. Edit below.';
}
function showEditor() {
  if (source?.kind === 'timeline') return;
  clearStage();
  stage.append(editor.canvas);
  source = { kind: 'timeline', el: editor.canvas };
}

// A URL the browser can play: the file itself, or a converted copy from the server
async function playableUrl(file) {
  if (NATIVE.test(file.name)) {
    const url = URL.createObjectURL(file);
    const ok = await new Promise((res) => {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.src = url;
      v.onloadedmetadata = () => res(v.videoWidth > 0);
      v.onerror = () => res(false);
    });
    if (ok) return url;
    URL.revokeObjectURL(url);
  }
  return convertToUrl(file);
}

async function convertToUrl(file) {
  const bar = $('progress');
  bar.style.display = 'block'; bar.firstElementChild.style.width = '0%';
  $('sourceNote').textContent = `Converting ${file.name} so the browser can play it…`;
  const duration = await probeDuration(file);
  try {
    const res = await fetch('/api/convert?duration=' + duration, { method: 'POST', body: file });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let text = '', result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, nl); text = text.slice(nl + 1);
        const p = /^progress (-?[\d.]+)/.exec(line);
        if (p) bar.firstElementChild.style.width = (+p[1] < 0 ? 50 : Math.min(100, +p[1] * 100)) + '%';
        if (line.startsWith('done ')) result = line.slice(5);
        if (line.startsWith('error ')) throw new Error(line.slice(6));
      }
    }
    if (!result) throw new Error('the converter stopped unexpectedly');
    $('sourceNote').textContent = `Converted ${file.name}.`;
    return result;
  } catch (e) {
    $('sourceNote').innerHTML = `<span class="warn">Couldn't convert ${file.name}: ${e.message}</span>`;
    return null;
  } finally {
    bar.style.display = 'none';
  }
}

// Ask the browser for the duration (for the progress bar); unknown formats just give 0
function probeDuration(file) {
  return new Promise((res) => {
    const v = document.createElement('video'), url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); res(Number.isFinite(d) ? d : 0); };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 1500);
    v.src = url;
  });
}

// YouTube: the embedded player plays the video and sound. Pages can't read its pixels
// directly, so we capture this tab (one click on Chrome's prompt) and crop to the player.
function youtubeId(link) {
  const m = /(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(link) || /^([\w-]{11})$/.exec(link.trim());
  return m ? m[1] : null;
}
async function openYouTube(link) {
  const id = youtubeId(link);
  if (!id) { $('sourceNote').innerHTML = '<span class="warn">That doesn\'t look like a YouTube link.</span>'; return; }
  clearStage();
  const frame = document.createElement('iframe');
  frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  stage.append(frame);
  $('sourceText').textContent = 'YouTube ' + id;
  $('sourceNote').innerHTML = 'Chrome will ask to share <b>this tab</b>. Choose it and click Share, then the player area is sent to the OLED. (Keep this tab visible while it plays.)';
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    const track = stream.getVideoTracks()[0];
    // Region Capture: crop the shared tab to just the player, if the browser supports it
    let cropped = false;
    if (window.CropTarget && track.cropTo) {
      try { await track.cropTo(await CropTarget.fromElement(stage)); cropped = true; } catch {}
    }
    const v = document.createElement('video');
    v.muted = true; v.srcObject = stream; v.play();
    source = { kind: 'youtube', el: v, stream, cropToStage: !cropped };
    track.addEventListener('ended', () => { if (source?.stream === stream) { source = null; $('sourceNote').textContent = 'Stopped sharing. Load the link again to restart.'; } });
    $('sourceNote').textContent = 'Streaming the YouTube player to the OLED. Sound plays here.';
  } catch {
    $('sourceNote').innerHTML = '<span class="warn">Sharing was cancelled, so only the browser plays it. Load the link again to retry.</span>';
  }
}

// Any other tab or window (its sound stays with that tab)
async function openCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    clearStage();
    const v = document.createElement('video');
    v.muted = true; v.srcObject = stream; v.controls = false;
    stage.append(v);
    v.play();
    source = { kind: 'capture', el: v, stream };
    $('sourceText').textContent = 'Captured ' + (stream.getVideoTracks()[0].label || 'screen');
    $('sourceNote').textContent = 'Mirroring the shared tab or window. Its sound plays from that tab.';
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (source?.stream === stream) { clearStage(); $('drop').style.display = 'flex'; $('sourceText').textContent = 'No video'; } });
  } catch {}
}

$('fileInput').onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
$('ytBtn').onclick = () => openYouTube($('ytInput').value);
$('ytInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') openYouTube($('ytInput').value); });
$('captureBtn').onclick = openCapture;
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) return openFiles(e.dataTransfer.files);
  const link = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (link && youtubeId(link)) { $('ytInput').value = link; openYouTube(link); }
});

// ---------- the editor ----------
const editor = createEditor({
  els: { timeline: $('timeline'), props: $('clipProps'), play: $('edPlay'), rewind: $('edRewind'), time: $('edTime'), split: $('edSplit'), del: $('edDelete'), clear: $('edClear') },
  playableUrl,
  onSelect: () => setTimeout(syncUI),   // deferred: the Picture panel code loads after this
  toast: (m) => { $('sourceNote').textContent = m; },
});
editor.restore().then((ok) => { if (ok) { showEditor(); $('sourceText').textContent = 'Edit (restored)'; } });

// ---------- picture pipeline ----------
// A "look" is the per-picture settings: framing, dither and tone. In the editor each clip
// can have its own (clip.look); otherwise the default look (the saved settings) applies.
// Shades (B&W / 4 greys) is always global: the board stores a whole video in one mode.
const LOOK_KEYS = ['fit', 'pan', 'dither', 'brightness', 'contrast', 'gamma', 'sharpen', 'invert'];
const lookOf = (o) => Object.fromEntries(LOOK_KEYS.map((k) => [k, o[k]]));
const clipLook = (clip) => (clip?.look ? { ...lookOf(settings), ...clip.look } : lookOf(settings));

const big = new OffscreenCanvas(288, 160), bigCtx = big.getContext('2d', { willReadFrequently: false });
const small = new OffscreenCanvas(OW, OH), smallCtx = small.getContext('2d', { willReadFrequently: true });
const lvl = new Uint8Array(OW * OH), lvlB = new Uint8Array(OW * OH);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Source rectangle (in source pixels) and where it lands on the 72x40 screen
function layout(sw, sh, look) {
  const target = OW / OH, aspect = sw / sh;
  if (look.fit === 'stretch') return { s: [0, 0, sw, sh], d: [0, 0, OW, OH] };
  if (look.fit === 'fit') {
    if (aspect > target) { const h = OW / aspect; return { s: [0, 0, sw, sh], d: [0, (OH - h) / 2, OW, h] }; }
    const w = OH * aspect; return { s: [0, 0, sw, sh], d: [(OW - w) / 2, 0, w, OH] };
  }
  // crop to fill; "Keep" slides the crop window across the frame
  const k = look.pan / 100;
  if (aspect > target) { const w = sh * target; return { s: [(sw - w) * k, 0, w, sh], d: [0, 0, OW, OH] }; }
  const h = sw / target; return { s: [0, (sh - h) * k, sw, h], d: [0, 0, OW, OH] };
}

// Shrink a video (or canvas) to 72x40 in the small canvas, framed by a look
function shrink(v, look, cropToStage) {
  if (!v) return false;
  const isCanvas = v instanceof HTMLCanvasElement;
  if (!isCanvas && (v.readyState < 2 || !v.videoWidth)) return false;
  let sx = 0, sy = 0, sw = isCanvas ? v.width : v.videoWidth, sh = isCanvas ? v.height : v.videoHeight;
  if (cropToStage) {
    // No Region Capture: work out where the player sits inside the shared tab
    const r = stage.getBoundingClientRect(), fx = sw / innerWidth, fy = sh / innerHeight;
    sx = r.left * fx; sy = r.top * fy; sw = r.width * fx; sh = r.height * fy;
  }
  const L = layout(sw, sh, look);
  // Two-step shrink (to 4x, then 1x) averages better than one big jump
  bigCtx.fillStyle = '#000'; bigCtx.fillRect(0, 0, big.width, big.height);
  bigCtx.imageSmoothingQuality = 'high';
  bigCtx.drawImage(v, sx + L.s[0], sy + L.s[1], L.s[2], L.s[3], L.d[0] * 4, L.d[1] * 4, L.d[2] * 4, L.d[3] * 4);
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(big, 0, 0, OW, OH);
  return true;
}

// Brightness of the small canvas after a look's tone settings (0..255 per pixel)
function toneGray(look) {
  const d = smallCtx.getImageData(0, 0, OW, OH).data;
  const { brightness, contrast, gamma, sharpen, invert } = look;
  const lum = new Float32Array(OW * OH), out = new Float32Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const i = y * OW + x;
    let v = lum[i];
    if (sharpen > 0) {
      // unsharp mask against the 3x3 average: edges matter a lot at 72x40
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < OW && yy >= 0 && yy < OH) { sum += lum[yy * OW + xx]; n++; }
      }
      v += sharpen * (v - sum / n);
    }
    v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, gamma);
    v = (v - 128) * contrast + 128 + brightness * 1.28;
    if (invert) v = 255 - v;
    out[i] = Math.max(0, Math.min(255, v));
  }
  return out;
}

// Grey values -> OLED levels (0..3) with a dither style
function quantiseInto(gray, d, out) {
  const N = settings.shades, step = 255 / (N - 1), scale = 3 / (N - 1);
  if (d === 'threshold' || d === 'bayer') {
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      const i = y * OW + x, v = gray[i];
      const q = d === 'bayer' ? Math.floor(v / step + (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16) : Math.round(v / step);
      out[i] = Math.min(N - 1, Math.max(0, q)) * scale;
    }
    return;
  }
  const g = Float32Array.from(gray);
  const spread = d === 'floyd'
    ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
    : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const i = y * OW + x, q = Math.min(N - 1, Math.max(0, Math.round(g[i] / step)));
    out[i] = q * scale;
    const err = g[i] - q * step;
    for (const [ox, oy, w] of spread) { const nx = x + ox, ny = y + oy; if (nx >= 0 && nx < OW && ny < OH) g[ny * OW + nx] += err * w; }
  }
}

// One clip through its own look: { look, gray } or null if it has no picture yet
function clipFrame(entry) {
  const look = clipLook(entry.clip);
  return shrink(entry.el, look) ? { look, gray: toneGray(look) } : null;
}

// The edit at the current time: each visible clip uses its own look, then the
// transition combines them (crossfades blend tones; wipes/dissolves pick per pixel)
function timelineLevels() {
  const info = editor.activeInfo();
  const parts = info.entries.map(clipFrame);
  const [A, B] = parts;
  if (!A && !B) return false;
  if (!B || !A) { const one = A || B; quantiseInto(one.gray, one.look.dither, lvl); return true; }
  const p = info.p, n = OW * OH;
  if (info.type === 'crossfade' || info.type === 'black') {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      g[i] = info.type === 'crossfade' ? A.gray[i] * (1 - p) + B.gray[i] * p
        : p < 0.5 ? A.gray[i] * (1 - p * 2) : B.gray[i] * (p * 2 - 1);
    }
    quantiseInto(g, (p < 0.5 ? A : B).look.dither, lvl);
    return true;
  }
  quantiseInto(A.gray, A.look.dither, lvl);
  quantiseInto(B.gray, B.look.dither, lvlB);
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const take = info.type === 'wipe' ? x < p * OW : info.type === 'wipeLeft' ? x >= (1 - p) * OW : BAYER[(y & 3) * 4 + (x & 3)] < p * 16;
    if (take) lvl[y * OW + x] = lvlB[y * OW + x];
  }
  return true;
}

// Fill lvl for the current source and return the packet for the board (or null)
function makePacket() {
  if (!source) return null;
  if (source.kind === 'timeline') { if (!editor.hasClips() || !timelineLevels()) return null; }
  else {
    if (!shrink(source.el, lookOf(settings), source.cropToStage)) return null;
    quantiseInto(toneGray(settings), settings.dither, lvl);
  }
  return pack();
}

function packPlane(out, off, test) {
  for (let page = 0; page < OH / 8; page++) for (let x = 0; x < OW; x++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) if (test(lvl[(page * 8 + bit) * OW + x])) b |= 1 << bit;
    out[off + page * OW + x] = b;
  }
}
function pack() {
  if (settings.shades === 2) { const p = new Uint8Array(2 + PLANE); p[0] = 0xA5; p[1] = 0x5A; packPlane(p, 2, (v) => v > 0); return p; }
  const p = new Uint8Array(3 + PLANE * 2);
  p[0] = 0xA5; p[1] = 0x5B; p[2] = 1;
  packPlane(p, 3, (v) => v & 1); packPlane(p, 3 + PLANE, (v) => v & 2);
  return p;
}

const oledCtx = $('oled').getContext('2d'), oledImg = oledCtx.createImageData(OW, OH);
const LEVEL = [0, 1, 2, 3].map((l) => [0x9f, 0xe3, 0xff].map((c) => Math.round(c * l / 3)));
function drawPreview() {
  for (let i = 0; i < OW * OH; i++) { const c = LEVEL[lvl[i]]; oledImg.data.set([c[0], c[1], c[2], 255], i * 4); }
  oledCtx.putImageData(oledImg, 0, 0);
}

// Frame loop: send each new video frame (at most ~40/s, dropping frames if USB is busy)
let lastSent = 0, sentCount = 0, lastVideoTime = -1;
function tick(now) {
  requestAnimationFrame(tick);
  if (!source) return;
  if (now - lastSent < 24) return;
  const packet = makePacket();
  if (!packet) return;
  drawPreview();
  if (writer && !sending) { lastSent = now; send(packet); }
}
requestAnimationFrame(tick);
window.videoOLED = { editor, makePacket, getSource: () => source, clipFrame };   // for debugging from the console
setInterval(() => { $('sentFps').textContent = `sent ${sentCount} fps`; sentCount = 0; }, 1000);

// ---------- Web Serial ----------
let port = null, writer = null, reader = null, sending = false, lastPort = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  try { lastPort = await navigator.serial.requestPort(); await openPort(lastPort, true); }
  catch (e) { if (e.name !== 'NotFoundError') setSerial(false, 'Could not open: ' + e.message); }
}
async function openPort(p, reset) {
  port = p;
  await port.open({ baudRate: 115200 });
  if (reset) {
    // Opening the port can leave the ESP32-C3 in its bootloader; pulse a normal reset
    setSerial(false, 'Restarting board…');
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(150);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(1200);
    if (!port?.writable) return;
  }
  writer = port.writable.getWriter();
  setSerial(true);
  readLoop();
}
async function disconnect(keepChoice) {
  try { await reader?.cancel(); } catch {}
  try { writer?.releaseLock(); await port?.close(); } catch {}
  port = writer = reader = null;
  if (!keepChoice) lastPort = null;
  setSerial(false);
}
async function readLoop() {
  const dec = new TextDecoder();
  let text = '';
  try {
    reader = port.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const m = /^STATS (\d+) (\d+)/.exec(text.slice(0, nl));
        text = text.slice(nl + 1);
        if (m) $('boardFps').textContent = settings.shades === 4 ? `board ${m[2]} fps · greys ${Math.round(m[1] / 3)} Hz` : `board ${m[2]} fps`;
      }
    }
  } catch {} finally { try { reader?.releaseLock(); } catch {} }
}
function send(p) {
  sending = true;
  writer.write(p).then(() => { sentCount++; }, () => disconnect()).finally(() => { sending = false; });
}
function setSerial(on, msg) {
  $('serialDot').className = 'dot' + (on ? ' on' : msg ? ' warn' : '');
  $('serialText').textContent = on ? 'Board connected' : msg || 'Board not connected';
  $('connectBtn').textContent = on ? 'Disconnect' : 'Connect board';
  if (!on) $('boardFps').textContent = 'board –';
}
$('connectBtn').onclick = () => (port ? disconnect() : connect());
navigator.serial?.addEventListener('disconnect', (e) => { if (e.target === port) { port = writer = null; setSerial(false, 'Board unplugged'); } });
if (!('serial' in navigator)) { $('unsupported').style.display = 'block'; $('connectBtn').disabled = true; }

// Flash the receiver firmware (the board needs it once; it replaces whatever it runs now)
$('flashBtn').onclick = async () => {
  const dlg = $('dlg');
  const log = document.createElement('pre'); log.className = 'log'; log.textContent = 'Building and uploading the receiver…\n';
  const close = document.createElement('button'); close.textContent = 'Close'; close.disabled = true; close.onclick = () => dlg.close();
  dlg.innerHTML = '<h2 style="margin:0 0 10px;font-size:15px">Flash receiver</h2>';
  dlg.append(log, Object.assign(document.createElement('div'), { style: 'display:flex;justify-content:flex-end;margin-top:12px' }));
  dlg.lastChild.append(close);
  dlg.showModal();
  const was = !!port;
  if (was) await disconnect(true);
  try {
    const res = await fetch('/api/flash', { method: 'POST' });
    const r = res.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await r.read(); if (done) break; log.textContent += dec.decode(value, { stream: true }); log.scrollTop = log.scrollHeight; }
  } catch (e) { log.textContent += '\n' + e.message; }
  const ok = /\[exit 0\]/.test(log.textContent);
  log.textContent += ok ? '\nDone. Now click Connect board.' : '\nSomething went wrong; see above.';
  close.disabled = false;
  if (ok && was && lastPort) setTimeout(async () => { try { await openPort(lastPort, false); } catch {} }, 1500);
};

// ---------- settings UI ----------
// The Picture panel edits the selected clip's look in the editor; with no clip selected
// (or for YouTube / captures) it edits the default look.
const editingClip = () => (source?.kind === 'timeline' ? editor.selectedClip() : null);
const currentLook = () => { const c = editingClip(); return c ? clipLook(c) : lookOf(settings); };
function setLook(key, value) {
  const c = editingClip();
  if (c) { c.look = { ...clipLook(c), [key]: value }; editor.touch(); }
  else { settings[key] = value; persist(); }
  syncUI();
}
function syncUI() {
  const L = currentLook(), c = editingClip();
  for (const b of $('fitSeg').children) b.classList.toggle('on', b.dataset.v === L.fit);
  for (const b of $('shadesSeg').children) b.classList.toggle('on', Number(b.dataset.v) === settings.shades);
  $('panRow').style.opacity = L.fit === 'crop' ? 1 : 0.35;
  for (const [id, fmt] of [['pan', (v) => v + '%'], ['brightness', (v) => v], ['contrast', (v) => v.toFixed(2)], ['gamma', (v) => v.toFixed(2)], ['sharpen', (v) => v.toFixed(1)]]) {
    $(id).value = L[id]; $(id + 'Out').textContent = fmt(L[id]);
  }
  $('dither').value = L.dither;
  $('invert').checked = L.invert;
  $('lookTarget').innerHTML = c
    ? `Editing <b>clip ${editor.clipIndex(c) + 1}</b> · ${editor.clipName(c)}${c.look ? '' : ' (using the default look)'}`
    : source?.kind === 'timeline' ? 'Editing the <b>default look</b> (used by clips you haven\'t changed). Select a clip to give it its own.' : 'Picture settings';
  $('lookButtons').style.display = c ? 'flex' : 'none';
}
$('fitSeg').onclick = (e) => { if (e.target.dataset.v) setLook('fit', e.target.dataset.v); };
$('shadesSeg').onclick = (e) => { if (e.target.dataset.v) { settings.shades = Number(e.target.dataset.v); syncUI(); persist(); } };
for (const id of ['pan', 'brightness', 'contrast', 'gamma', 'sharpen']) $(id).oninput = (e) => setLook(id, Number(e.target.value));
$('dither').onchange = (e) => setLook('dither', e.target.value);
$('invert').onchange = (e) => setLook('invert', e.target.checked);
$('lookAll').onclick = () => { const L = currentLook(); for (const c of editor.allClips()) c.look = { ...L }; editor.touch(); syncUI(); };
$('lookReset').onclick = () => { const c = editingClip(); if (c) { delete c.look; editor.touch(); syncUI(); } };
$('lookDefault').onclick = () => { const c = editingClip(); if (c) { Object.assign(settings, clipLook(c)); persist(); syncUI(); } };
syncUI();

// ---------- Save to board: encode the whole video, store it in the board's flash ----------
// Format matches firmware/src/main.cpp: 32-byte "OLV1" header, then per frame
// u16 length + u8 flags (bit0 keyframe, bit1 stored raw) + raw-deflate(planes, XOR'd with the previous frame)
const CAPACITY = 0x2F0000;
async function deflateRaw(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}
function seek(v, t) { return new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = t; }); }

$('saveBtn').onclick = async () => {
  if (source?.kind !== 'timeline' || !editor.hasClips()) return alert('Open some video files first. Save to board stores your edit (it works with files, not YouTube or captures).');
  const fps = Math.min(30, Math.max(5, Number(prompt('Frames per second to store (5–30):', '24')) || 24));
  const v = { duration: editor.duration() };
  const planes = settings.shades === 4 ? 2 : 1, size = PLANE * planes, n = Math.floor(v.duration * fps);
  const dlg = $('dlg'), log = Object.assign(document.createElement('pre'), { className: 'log' });
  const close = Object.assign(document.createElement('button'), { textContent: 'Close', disabled: true, onclick: () => dlg.close() });
  dlg.innerHTML = '<h2 style="margin:0 0 10px;font-size:15px">Save to board</h2>';
  dlg.append(log, close); dlg.showModal();
  const say = (t) => { log.textContent += t; log.scrollTop = log.scrollHeight; };
  const wasT = editor.time();
  editor.setPlaying(false); editor.setMuted(true);
  say(`Encoding ${n} frames at ${fps} fps, ${planes === 2 ? '4 greys' : 'black & white'}…\n`);
  const chunks = [];
  let total = 32, prev = null;
  for (let i = 0; i < n; i++) {
    await editor.renderAt((i + 0.5) / fps);
    makePacket(); drawPreview();
    const cur = new Uint8Array(size);
    packPlane(cur, 0, planes === 2 ? (x) => x & 1 : (x) => x > 0);
    if (planes === 2) packPlane(cur, PLANE, (x) => x & 2);
    const key = !prev || i % (fps * 2) === 0;
    const payload = key ? cur : cur.map((b, k) => b ^ prev[k]);
    const z = await deflateRaw(payload);
    const stored = z.length >= size, data = stored ? payload : z;
    const rec = new Uint8Array(3 + data.length);
    rec[0] = data.length & 255; rec[1] = data.length >> 8; rec[2] = (key ? 1 : 0) | (stored ? 2 : 0);
    rec.set(data, 3);
    chunks.push(rec); total += rec.length; prev = cur;
    if (i % 100 === 0) say(`  ${i}/${n} frames, ${(total / 1024).toFixed(0)} KB\n`);
    if (total > CAPACITY) break;
  }
  editor.setMuted(false); editor.setTime(wasT);
  if (total > CAPACITY) { say(`\nToo big for the board (${(CAPACITY / 1024).toFixed(0)} KB). Try fewer fps, Black & white, or the Ordered / None dither (they compress far better).\n`); close.disabled = false; return; }
  const head = new Uint8Array(32), dv = new DataView(head.buffer);
  head.set([79, 76, 86, 49]); dv.setUint16(4, OW, true); dv.setUint16(6, OH, true); head[8] = planes; head[9] = fps;
  dv.setUint32(12, chunks.length, true); dv.setUint32(16, total - 32, true);
  say(`\nEncoded: ${(total / 1024).toFixed(0)} KB (${(total / CAPACITY * 100).toFixed(0)}% of the board's space).\nUploading…\n`);
  if (port) await disconnect(true);   // the upload tool needs the USB port
  try {
    const res = await fetch('/api/save-video', { method: 'POST', body: new Blob([head, ...chunks]) });
    const r = res.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await r.read(); if (done) break; say(dec.decode(value, { stream: true })); }
  } catch (e) { say('\n' + e.message); }
  say(/\[exit 0\]/.test(log.textContent) ? '\nDone! The board is now playing the video on its own (BOOT: pause, hold: restart).' : '\nSomething went wrong; see above.');
  close.disabled = false;
};
