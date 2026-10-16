// Video editor for the Video -> OLED page: media bin, a one-track timeline of clips
// (reorder, trim, split, delete), transitions between clips, and playback with sound.
// The edit is drawn onto `canvas`; the page's picture pipeline reads that canvas
// like any video, so the OLED preview, live streaming and Save to board all use it.
//
// Timeline model: clips play in order. A transition after clip i overlaps the end of
// clip i with the start of clip i+1 for its duration, so the edit gets shorter by it.

const TRANSITIONS = [['cut', 'Cut'], ['crossfade', 'Crossfade'], ['black', 'Fade through black'], ['dissolve', 'Dither dissolve'], ['wipe', 'Wipe →'], ['wipeLeft', 'Wipe ←']];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const uid = () => Math.random().toString(36).slice(2, 10);

export function createEditor({ els, playableUrl, onChange, onSelect, toast }) {
  // ---------- state ----------
  let project = { media: [], clips: [] };   // media: {id, name, url, duration, w, h}; clips: {id, media, in, out, volume, trans:{type, dur}}
  let T = 0, playing = false, selected = null, zoom = 40;   // zoom = px per second
  const clipEls = new Map();   // clip id -> <video>
  const thumbs = new Map();    // media id -> [canvas...]
  const files = new Map();     // media id -> File (kept for persistence)

  // The composition canvas the stage shows and the OLED pipeline reads
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block';
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  const mask = document.createElement('canvas'); mask.width = 72; mask.height = 40;
  const mctx = mask.getContext('2d');

  // ---------- timeline maths ----------
  const len = (c) => Math.max(0.05, c.out - c.in);
  function transDur(i) {
    const c = project.clips[i], n = project.clips[i + 1];
    if (!n || !c.trans || c.trans.type === 'cut') return 0;
    return Math.max(0, Math.min(c.trans.dur, len(c) / 2, len(n) / 2));
  }
  function starts() {
    const s = [];
    let t = 0;
    project.clips.forEach((c, i) => { s.push(t); t += len(c) - transDur(i); });
    return s;
  }
  function duration() {
    const s = starts(), n = project.clips.length;
    return n ? s[n - 1] + len(project.clips[n - 1]) : 0;
  }
  // The clips showing at time t: [{i, clip, local}] (one, or two during a transition)
  function activeAt(t) {
    const s = starts(), out = [];
    project.clips.forEach((c, i) => { if (t >= s[i] && t < s[i] + len(c)) out.push({ i, clip: c, local: t - s[i] }); });
    if (!out.length && project.clips.length && t >= duration() - 1e-6) { const i = project.clips.length - 1; out.push({ i, clip: project.clips[i], local: len(project.clips[i]) - 0.001 }); }
    return out.slice(0, 2);
  }

  // ---------- media + clip elements ----------
  function elFor(clip) {
    let v = clipEls.get(clip.id);
    const m = project.media.find((x) => x.id === clip.media);
    if (!v && m) {
      v = document.createElement('video');
      v.preload = 'auto'; v.playsInline = true; v.src = m.url;
      v.load();   // start loading now, not when it's first played
      clipEls.set(clip.id, v);
    }
    return v;
  }
  // A video created while the tab was hidden can get stuck unloaded (Chrome defers
  // media loading in background tabs and doesn't always resume): kick it again.
  function ensureLoading(v) {
    if (!v || v.readyState > 0 || v.networkState === 2) return;   // 2 = loading
    const now = performance.now();
    if (now - (v._kicked || 0) < 1500) return;
    v._kicked = now;
    v.load();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const v of clipEls.values()) { v._kicked = 0; ensureLoading(v); } });

  function dropUnusedEls() {
    const ids = new Set(project.clips.map((c) => c.id));
    for (const [id, v] of clipEls) if (!ids.has(id)) { v.pause(); v.removeAttribute('src'); v.load(); clipEls.delete(id); }
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      const url = await playableUrl(file);
      if (!url) continue;
      const info = await probe(url);
      if (!info) { toast(`Couldn't read ${file.name}`); continue; }
      const m = { id: uid(), name: file.name, url, ...info };
      project.media.push(m);
      if (url.startsWith('blob:')) files.set(m.id, file);
      project.clips.push({ id: uid(), media: m.id, in: 0, out: info.duration, volume: 1, trans: { type: 'cut', dur: 1 } });
      if (project.media.length === 1) sizeCanvas(info.w, info.h);
      makeThumbs(m);
    }
    changed();
  }
  function probe(url) {
    return new Promise((res) => {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.src = url;
      v.onloadedmetadata = () => res(v.videoWidth ? { duration: v.duration, w: v.videoWidth, h: v.videoHeight } : null);
      v.onerror = () => res(null);
    });
  }
  function sizeCanvas(w, h) {
    canvas.width = 640; canvas.height = Math.round(640 * h / w / 2) * 2;
    tmp.width = canvas.width; tmp.height = canvas.height;
  }
  // A strip of small thumbnails per media, for the timeline
  async function makeThumbs(m) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = m.url;
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
    const list = [];
    for (let k = 0; k < 10; k++) {
      await new Promise((r) => { v.onseeked = r; v.currentTime = (k + 0.5) / 10 * m.duration; });
      const c = document.createElement('canvas'); c.width = 64; c.height = Math.round(64 * m.h / m.w);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      list.push(c);
    }
    thumbs.set(m.id, list);
    draw();
  }

  // ---------- composing a frame ----------
  function drawClip(c2d, entry) {
    const v = elFor(entry.clip);
    if (!v || v.readyState < 2) return;
    const W = canvas.width, H = canvas.height, s = Math.min(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    c2d.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  }
  function compose() {
    const W = canvas.width, H = canvas.height;
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const act = activeAt(T);
    if (!act.length) return;
    if (act.length === 1) { drawClip(ctx, act[0]); return; }
    const [a, b] = act, d = transDur(a.i), p = d ? Math.min(1, Math.max(0, b.local / d)) : 1, type = a.clip.trans.type;
    if (type === 'black') {
      if (p < 0.5) { ctx.globalAlpha = 1 - p * 2; drawClip(ctx, a); }
      else { ctx.globalAlpha = p * 2 - 1; drawClip(ctx, b); }
      ctx.globalAlpha = 1;
      return;
    }
    drawClip(ctx, a);
    tctx.globalCompositeOperation = 'source-over';
    tctx.fillStyle = '#000'; tctx.fillRect(0, 0, W, H);
    drawClip(tctx, b);
    if (type === 'crossfade') { ctx.globalAlpha = p; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1; }
    else if (type === 'wipe') { const x = W * p; ctx.drawImage(tmp, 0, 0, x, H, 0, 0, x, H); }
    else if (type === 'wipeLeft') { const x = W * (1 - p); ctx.drawImage(tmp, x, 0, W - x, H, x, 0, W - x, H); }
    else if (type === 'dissolve') {
      // OLED-pixel-sized blocks switch over in an ordered pattern
      const img = mctx.createImageData(72, 40);
      for (let y = 0; y < 40; y++) for (let x = 0; x < 72; x++) if (BAYER[(y & 3) * 4 + (x & 3)] < p * 16) img.data[(y * 72 + x) * 4 + 3] = 255;
      mctx.putImageData(img, 0, 0);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(mask, 0, 0, W, H);
      tctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(tmp, 0, 0);
    }
  }

  // ---------- playback ----------
  // Keep each visible clip's <video> at the right place; audio follows the visible clips
  function syncEls(seekTolerance) {
    const act = activeAt(T), s = starts(), activeIds = new Set(act.map((e) => e.clip.id));
    for (const e of act) {
      const v = elFor(e.clip);
      if (!v) continue;
      ensureLoading(v);
      const want = e.clip.in + e.local;
      if (Math.abs(v.currentTime - want) > seekTolerance) v.currentTime = want;
      // audio: ramp across transitions
      let gain = e.clip.volume ?? 1;
      if (act.length === 2) {
        const [a, b] = act, d = transDur(a.i) || 1, p = Math.min(1, b.local / d);
        const black = a.clip.trans.type === 'black';
        gain *= e === a ? (black ? Math.max(0, 1 - p * 2) : 1 - p) : (black ? Math.max(0, p * 2 - 1) : p);
      }
      v.volume = Math.max(0, Math.min(1, gain));
      v.muted = muted;
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
    project.clips.forEach((c, i) => {
      if (activeIds.has(c.id)) return;
      const v = clipEls.get(c.id);
      if (v && !v.paused) v.pause();
      if (v && T < s[i] && s[i] - T < 1.5) ensureLoading(v);
      // pre-roll: park the next clip on its first frame so the cut is instant
      if (v && T < s[i] && s[i] - T < 1.5 && Math.abs(v.currentTime - c.in) > 0.05) v.currentTime = c.in;
    });
  }
  let muted = false, last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!project.clips.length) return;
    if (playing) {
      T += dt;
      if (T >= duration()) { T = duration(); setPlaying(false); }
    }
    syncEls(playing ? 0.3 : 0.04);
    compose();
    if (playing) { draw(); updateTime(); }
  }
  requestAnimationFrame(frame);

  function setPlaying(v) {
    if (v && T >= duration() - 0.05) T = 0;
    playing = v;
    els.play.textContent = v ? '❚❚' : '▶';
    if (!v) for (const el of clipEls.values()) el.pause();
  }
  function setTime(t) { T = Math.max(0, Math.min(duration(), t)); updateTime(); draw(); }
  function updateTime() { els.time.textContent = `${fmt(T)} / ${fmt(duration())}`; }
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

  // For Save to board: put every visible clip exactly at time t, then compose
  async function renderAt(t) {
    T = t;
    const act = activeAt(T);
    await Promise.all(act.map((e) => new Promise((res) => {
      const v = elFor(e.clip), want = e.clip.in + e.local;
      if (!v || Math.abs(v.currentTime - want) < 0.001) return res();
      v.addEventListener('seeked', res, { once: true });
      v.currentTime = want;
    })));
    compose();
  }

  // ---------- editing ----------
  function changed() {
    T = Math.min(T, duration());
    dropUnusedEls();
    draw(); updateTime(); renderProps();
    save();
    onChange?.();
  }
  function split() {
    const act = activeAt(T);
    const e = act.find((x) => x.clip.id === selected) || act[act.length - 1];
    if (!e) return;
    const at = e.clip.in + e.local;
    if (at - e.clip.in < 0.1 || e.clip.out - at < 0.1) return toast('Too close to the edge of the clip to split');
    const right = { ...structuredClone(e.clip), id: uid(), in: at };
    e.clip.out = at;
    right.trans = e.clip.trans; e.clip.trans = { type: 'cut', dur: 1 };
    project.clips.splice(e.i + 1, 0, right);
    selected = right.id;
    changed();
  }
  function remove() {
    const i = project.clips.findIndex((c) => c.id === selected);
    if (i < 0) return;
    project.clips.splice(i, 1);
    selected = project.clips[Math.min(i, project.clips.length - 1)]?.id ?? null;
    changed();
  }

  // ---------- timeline drawing + interaction ----------
  const tl = els.timeline, g = tl.getContext('2d');
  const RULER = 20, TRACK_Y = 26, TRACK_H = 58;
  let scrollX = 0;
  const xOf = (t) => 10 + t * zoom - scrollX, tOf = (x) => (x - 10 + scrollX) / zoom;

  function draw() {
    const dpr = devicePixelRatio, w = tl.clientWidth, h = tl.clientHeight;
    if (tl.width !== w * dpr || tl.height !== h * dpr) { tl.width = w * dpr; tl.height = h * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#15181d'; g.fillRect(0, 0, w, h);
    // ruler
    g.fillStyle = '#1d2026'; g.fillRect(0, 0, w, RULER);
    g.fillStyle = '#8a9099'; g.font = '11px system-ui'; g.textBaseline = 'middle';
    const step = zoom > 60 ? 1 : zoom > 20 ? 5 : zoom > 6 ? 10 : 30;
    for (let s = Math.floor(tOf(0) / step) * step; xOf(s) < w; s += step) {
      if (s < 0) continue;
      const x = xOf(s);
      g.fillRect(x, 12, 1, RULER - 12);
      g.fillText(fmt(s).replace(/\.\d+$/, ''), x + 3, 8);
    }
    if (!project.clips.length) {
      g.fillStyle = '#8a9099'; g.fillText('Open or drop video files to start editing. Each file becomes a clip.', 12, TRACK_Y + TRACK_H / 2);
      return;
    }
    const s = starts();
    project.clips.forEach((c, i) => {
      const x0 = xOf(s[i]), x1 = xOf(s[i] + len(c)), m = project.media.find((q) => q.id === c.media);
      g.save();
      g.beginPath(); g.roundRect(x0, TRACK_Y, x1 - x0, TRACK_H, 5); g.clip();
      g.fillStyle = i % 2 ? '#2a3442' : '#2f3a2a'; g.fillRect(x0, TRACK_Y, x1 - x0, TRACK_H);
      // filmstrip: thumbnails along the clip, from the right part of the source
      const th = thumbs.get(c.media);
      if (th && m) {
        const tw = (TRACK_H - 16) * m.w / m.h;
        for (let x = x0; x < x1; x += tw) {
          const srcT = c.in + ((x - x0) / zoom), k = Math.min(9, Math.max(0, Math.floor(srcT / m.duration * 10)));
          g.globalAlpha = 0.75; g.drawImage(th[k], x, TRACK_Y + 16, tw, TRACK_H - 16); g.globalAlpha = 1;
        }
      }
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x0, TRACK_Y, x1 - x0, 16);
      g.fillStyle = '#e6e8eb'; g.fillText(`${c.look ? '◐ ' : ''}${m?.name ?? '?'}  ${fmt(len(c)).replace(/^0:/, '')}`, x0 + 6, TRACK_Y + 8);
      g.restore();
      g.strokeStyle = c.id === selected ? '#8bd450' : '#3a414c'; g.lineWidth = c.id === selected ? 2 : 1;
      g.beginPath(); g.roundRect(x0 + 0.5, TRACK_Y + 0.5, x1 - x0 - 1, TRACK_H - 1, 5); g.stroke();
    });
    // transitions, drawn over the clips: hatched overlap + a diamond to click
    for (let i = 0; i < project.clips.length - 1; i++) {
      const d = transDur(i), cx = d ? xOf(s[i + 1] + d / 2) : xOf(s[i + 1]), cy = TRACK_Y + TRACK_H / 2;
      if (d) {
        g.fillStyle = 'rgba(232,176,74,.22)'; g.fillRect(xOf(s[i + 1]), TRACK_Y, d * zoom, TRACK_H);
        g.strokeStyle = 'rgba(232,176,74,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(xOf(s[i + 1]), TRACK_Y + TRACK_H); g.lineTo(xOf(s[i + 1] + d), TRACK_Y); g.stroke();
      }
      g.fillStyle = d ? '#e8b04a' : '#8a9099'; g.strokeStyle = '#15181d'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy - 8); g.lineTo(cx + 8, cy); g.lineTo(cx, cy + 8); g.lineTo(cx - 8, cy); g.closePath(); g.stroke(); g.fill();
    }
    // drop marker while reordering
    if (drag?.mode === 'move' && drag.started) { g.fillStyle = '#8bd450'; g.fillRect(drag.dropX - 1, TRACK_Y - 4, 3, TRACK_H + 8); }
    // playhead
    const px = xOf(T);
    g.fillStyle = '#e5604f'; g.fillRect(px - 0.5, 0, 1.5, h);
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
  }

  function hit(x, y) {
    if (y < TRACK_Y || y > TRACK_Y + TRACK_H || !project.clips.length) return { kind: 'empty' };
    const s = starts();
    for (let i = 0; i < project.clips.length - 1; i++) {
      const d = transDur(i), cx = d ? xOf(s[i + 1] + d / 2) : xOf(s[i + 1]);
      if (Math.abs(x - cx) <= 8 && Math.abs(y - (TRACK_Y + TRACK_H / 2)) <= 9) return { kind: 'trans', i };
    }
    // later clips sit on top during overlaps, so check from the end
    for (let i = project.clips.length - 1; i >= 0; i--) {
      const c = project.clips[i], x0 = xOf(s[i]), x1 = xOf(s[i] + len(c));
      if (x < x0 - 1 || x > x1 + 1) continue;
      if (x - x0 <= 6) return { kind: 'trimIn', i };
      if (x1 - x <= 6) return { kind: 'trimOut', i };
      return { kind: 'clip', i };
    }
    return { kind: 'empty' };
  }

  let drag = null;
  tl.addEventListener('pointerdown', (e) => {
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, hi = hit(x, y);
    tl.setPointerCapture(e.pointerId);
    if (hi.kind === 'trans') { selected = project.clips[hi.i].id; renderProps('trans'); draw(); return; }
    if (hi.kind === 'trimIn' || hi.kind === 'trimOut') {
      const c = project.clips[hi.i];
      selected = c.id;
      drag = { mode: hi.kind, c, x0: x, in0: c.in, out0: c.out, dur: project.media.find((m) => m.id === c.media).duration };
      renderProps(); return;
    }
    if (hi.kind === 'clip') { selected = project.clips[hi.i].id; drag = { mode: 'move', i: hi.i, x0: x, started: false }; renderProps(); draw(); }
    else drag = { mode: 'scrub' };
    if (hi.kind !== 'clip' || true) setTime(tOf(x));
  });
  tl.addEventListener('pointermove', (e) => {
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) { const hi = hit(x, y); tl.style.cursor = hi.kind === 'trimIn' || hi.kind === 'trimOut' ? 'ew-resize' : hi.kind === 'clip' ? 'grab' : hi.kind === 'trans' ? 'pointer' : 'default'; return; }
    if (drag.mode === 'scrub') { setTime(tOf(x)); return; }
    if (drag.mode === 'trimIn') { drag.c.in = Math.max(0, Math.min(drag.c.out - 0.1, drag.in0 + (x - drag.x0) / zoom)); draw(); updateTime(); return; }
    if (drag.mode === 'trimOut') { drag.c.out = Math.min(drag.dur, Math.max(drag.c.in + 0.1, drag.out0 + (x - drag.x0) / zoom)); draw(); updateTime(); return; }
    if (drag.mode === 'move') {
      if (!drag.started && Math.abs(x - drag.x0) < 5) return;
      drag.started = true;
      // insertion point: before the first clip whose middle is right of the pointer
      const s = starts();
      let to = project.clips.length;
      for (let i = 0; i < project.clips.length; i++) if (x < xOf(s[i] + len(project.clips[i]) / 2)) { to = i; break; }
      drag.to = to;
      drag.dropX = to < project.clips.length ? xOf(s[to]) : xOf(duration());
      draw();
    }
  });
  tl.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.mode === 'trimIn' || d.mode === 'trimOut') changed();
    if (d.mode === 'move' && d.started && d.to != null) {
      const [c] = project.clips.splice(d.i, 1);
      project.clips.splice(d.to > d.i ? d.to - 1 : d.to, 0, c);
      changed();
    }
    draw();
  });
  tl.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const r = tl.getBoundingClientRect(), x = e.clientX - r.left, at = tOf(x);
      zoom = Math.max(2, Math.min(400, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      scrollX = Math.max(0, 10 + at * zoom - x);   // zoom around the pointer
    } else scrollX = Math.max(0, scrollX + e.deltaX);
    draw();
  }, { passive: false });
  new ResizeObserver(draw).observe(tl);

  // ---------- properties for the selected clip ----------
  function renderProps(focus) {
    onSelect?.();
    const p = els.props, i = project.clips.findIndex((c) => c.id === selected);
    if (i < 0) { p.innerHTML = '<span class="note">Select a clip to trim it, set its volume, or choose the transition into the next clip. Click a diamond between clips for its transition.</span>'; return; }
    const c = project.clips[i], m = project.media.find((q) => q.id === c.media), last = i === project.clips.length - 1;
    p.innerHTML = '';
    const row = (label, el) => { const d = document.createElement('div'); d.className = 'row'; const s = document.createElement('span'); s.textContent = label; d.append(s, el); p.append(d); return el; };
    const num = (v, step, onset) => { const n = document.createElement('input'); n.type = 'number'; n.step = step; n.value = +v.toFixed(2); n.style.width = '90px'; n.onchange = () => { onset(parseFloat(n.value)); changed(); }; return n; };
    const title = document.createElement('div'); title.className = 'note'; title.style.margin = '0 0 6px'; title.textContent = `${m?.name} · clip ${i + 1} of ${project.clips.length}`;
    p.append(title);
    row('Start at (s)', num(c.in, 0.05, (v) => { c.in = Math.max(0, Math.min(c.out - 0.1, v)); }));
    row('End at (s)', num(c.out, 0.05, (v) => { c.out = Math.min(m.duration, Math.max(c.in + 0.1, v)); }));
    const vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.05; vol.value = c.volume ?? 1;
    vol.oninput = () => { c.volume = +vol.value; save(); };
    row('Volume', vol);
    if (!last) {
      const sel = document.createElement('select');
      for (const [v, l] of TRANSITIONS) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.append(o); }
      sel.value = c.trans.type;
      sel.onchange = () => { c.trans.type = sel.value; changed(); };
      row('Then', sel);
      if (c.trans.type !== 'cut') row('Over (s)', num(c.trans.dur, 0.1, (v) => { c.trans.dur = Math.max(0.1, v); }));
      if (focus === 'trans') setTimeout(() => sel.focus());
    }
  }

  // ---------- persistence: project in localStorage, original files in IndexedDB ----------
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('video-oled-editor', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        localStorage.setItem('video-oled-project', JSON.stringify({ media: project.media.map(({ url, ...m }) => ({ ...m, url: url.startsWith('blob:') ? null : url })), clips: project.clips }));
        const db = await idb(), tx = db.transaction('files', 'readwrite'), st = tx.objectStore('files');
        st.clear();
        for (const [id, f] of files) if (project.media.some((m) => m.id === id)) st.put(f, id);
      } catch {}
    }, 400);
  }
  async function restore() {
    try {
      const p = JSON.parse(localStorage.getItem('video-oled-project'));
      if (!p?.clips?.length) return false;
      const db = await idb();
      const get = (id) => new Promise((res) => { const r = db.transaction('files').objectStore('files').get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      for (const m of p.media) {
        if (!m.url) { const f = await get(m.id); if (f) { files.set(m.id, f); m.url = URL.createObjectURL(f); } }
        else if (!(await fetch(m.url, { method: 'HEAD' }).then((r) => r.ok, () => false))) m.url = null;   // converted copy expired
      }
      p.media = p.media.filter((m) => m.url);
      p.clips = p.clips.filter((c) => p.media.some((m) => m.id === c.media));
      if (!p.clips.length) return false;
      project = p;
      sizeCanvas(p.media[0].w, p.media[0].h);
      p.media.forEach(makeThumbs);
      changed();
      return true;
    } catch { return false; }
  }

  // ---------- keys ----------
  addEventListener('keydown', (e) => {
    if (!project.clips.length || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); split(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    else if (e.key === 'ArrowLeft') setTime(T - (e.shiftKey ? 1 : 1 / 24));
    else if (e.key === 'ArrowRight') setTime(T + (e.shiftKey ? 1 : 1 / 24));
    else if (e.key === 'Home') setTime(0);
  });
  els.play.onclick = () => setPlaying(!playing);
  els.rewind.onclick = () => setTime(0);
  els.split.onclick = split;
  els.del.onclick = remove;
  els.clear.onclick = () => { if (!project.clips.length || confirm('Remove all clips from the edit?')) { setPlaying(false); project = { media: [], clips: [] }; files.clear(); selected = null; changed(); } };

  draw(); updateTime(); renderProps();
  return {
    canvas, addFiles, restore, renderAt, duration,
    // what the OLED pipeline needs: the visible clips' videos and the transition between them
    activeInfo() {
      const act = activeAt(T);
      const entries = act.map((e) => ({ clip: e.clip, el: elFor(e.clip) }));
      if (act.length < 2) return { entries, type: 'cut', p: 1 };
      const d = transDur(act[0].i);
      return { entries, type: act[0].clip.trans.type, p: d ? Math.min(1, Math.max(0, act[1].local / d)) : 1 };
    },
    selectedClip: () => project.clips.find((c) => c.id === selected) || null,
    allClips: () => project.clips,
    clipIndex: (c) => project.clips.indexOf(c),
    clipName: (c) => project.media.find((m) => m.id === c.media)?.name || '',
    touch: () => { save(); draw(); },
    hasClips: () => project.clips.length > 0,
    setPlaying, isPlaying: () => playing, setMuted: (v) => { muted = v; },
    time: () => T, setTime,
  };
}
