// Video streamer server: static files + a button to flash the receiver firmware.
// Listens on localhost only (Web Serial needs a secure page; localhost counts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The video player firmware: plays a saved video, and shows live frames from USB
// (1-bit or 4-grey frames)
const firmwareDir = path.join(here, '..', 'firmware');
const VIDEO_OFFSET = '0x110000', VIDEO_CAPACITY = 0x2F0000;   // must match firmware/partitions.csv
const port = Number(process.env.PORT) || 8100;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let flashing = false;
// On Windows, tools like pio and ffmpeg are .exe/.cmd shims that need a shell to be found
const WIN = process.platform === 'win32';

// Converted videos live here; anything older than a day is cleared at startup
const cacheDir = path.join(here, '..', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
for (const f of fs.readdirSync(cacheDir)) { const p = path.join(cacheDir, f); if (Date.now() - fs.statSync(p).mtimeMs > 86400e3) fs.rmSync(p, { force: true }); }

// Convert whatever the browser can't play into H.264/AAC MP4 (hardware encoder, software fallback).
// The response streams progress lines ("progress 0.42") then "done /media/<id>.mp4".
function convert(req, res) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const input = path.join(cacheDir, 'in-' + id), output = path.join(cacheDir, id + '.mp4');
  const total = Number(new URL(req.url, 'http://x').searchParams.get('duration')) || 0;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  const out = fs.createWriteStream(input);
  req.pipe(out);
  out.on('finish', () => {
    const run = (encoder, retry) => {
      const args = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2,format=yuv420p",
        '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '23'] : ['-b:v', '4M']),
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output];
      const p = spawn('ffmpeg', args, { shell: WIN });
      let err = '';
      p.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d));
        if (m) res.write(total ? `progress ${(Number(m[1]) / 1e6 / total).toFixed(3)}\n` : `progress -1\n`);
      });
      p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
      p.on('error', (e) => { res.end(`error could not run ffmpeg: ${e.message}\n`); });
      p.on('close', (code) => {
        if (code === 0) { fs.rmSync(input, { force: true }); res.end(`done /media/${id}.mp4\n`); }
        else if (retry) run('libx264', false);
        else { fs.rmSync(input, { force: true }); res.end(`error ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}\n`); }
      });
    };
    // Apple's hardware encoder on macOS (fast); the portable software encoder elsewhere
    if (process.platform === 'darwin') run('h264_videotoolbox', true); else run('libx264', false);
  });
}

// Save to board: store the encoded video, install the player, then write the video
// into the board's "video" flash partition.
// Find the ESP32-C3 on any OS: ask PlatformIO for the serial ports and pick the one with
// Espressif's USB vendor ID (303A). macOS: /dev/cu.usbmodem…, Linux: /dev/ttyACM…, Windows: COM…
function findBoard() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('pio', ['device', 'list', '--json-output'], { shell: WIN });
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const ports = JSON.parse(out);
        const esp = ports.find((d) => /VID:PID=303A/i.test(d.hwid || ''));
        const usb = ports.find((d) => /usbmodem|usbserial|ttyACM|ttyUSB/i.test(d.port || ''));
        resolve((esp || usb)?.port || null);
      } catch { resolve(null); }
    });
  });
}
const NO_BOARD = 'The board was not found on USB. Plug it in with a data USB cable (and disconnect this page from it), then try again.\n[exit 1]\n';
function run(cmd, args, cwd, res) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, shell: WIN, env: { ...process.env, PLATFORMIO_DISABLE_PROGRESSBAR: 'true' } });
    p.stdout.on('data', (d) => res.write(d));
    p.stderr.on('data', (d) => res.write(d));
    p.on('error', (e) => { res.write(`\n[could not run ${cmd}: ${e.message}]\n`); resolve(1); });
    p.on('close', resolve);
  });
}
function saveVideo(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  if (flashing) return res.end('Already flashing.\n[exit 1]\n');
  const file = path.join(cacheDir, 'video.bin'), out = fs.createWriteStream(file);
  req.pipe(out);
  out.on('finish', async () => {
    const size = fs.statSync(file).size;
    if (size > VIDEO_CAPACITY) return res.end(`The video is ${size} bytes but the board holds ${VIDEO_CAPACITY}.\n[exit 1]\n`);
    const board = await findBoard();
    if (!board) return res.end(NO_BOARD);
    flashing = true;
    try {
      res.write(`Video: ${(size / 1024).toFixed(0)} KB of ${(VIDEO_CAPACITY / 1024).toFixed(0)} KB. Board on ${board}\n\n1/2 Installing the player firmware…\n`);
      let code = await run('pio', ['run', '-t', 'upload', '--upload-port', board], firmwareDir, res);
      if (code !== 0) return res.end(`\n[exit ${code}]\n`);
      await new Promise((r) => setTimeout(r, 1500));   // let the board re-appear after its reset
      res.write('\n2/2 Writing the video…\n');
      code = await run('pio', ['pkg', 'exec', '--package', 'tool-esptoolpy', '--', 'esptool.py', '--chip', 'esp32c3', '--port', (await findBoard()) || board,
        '--baud', '921600', 'write_flash', VIDEO_OFFSET, file], firmwareDir, res);
      res.end(`\n[exit ${code}]\n`);
    } finally { flashing = false; }
  });
}

// Serve a converted video with Range support, so the player can seek
function serveMedia(req, res, name) {
  const file = path.join(cacheDir, name);
  if (!/^[\w]+\.mp4$/.test(name) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const size = fs.statSync(file).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/convert' && req.method === 'POST') return convert(req, res);
  if (url.pathname.startsWith('/media/')) return serveMedia(req, res, url.pathname.slice(7));
  if (url.pathname === '/api/save-video' && req.method === 'POST') return saveVideo(req, res);
  if (url.pathname === '/api/flash' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (flashing) return res.end('Already flashing.\n[exit 1]\n');
    flashing = true;
    findBoard().then(async (board) => {
      if (!board) return res.end(NO_BOARD);
      res.write(`Board found on ${board}\n`);
      const code = await run('pio', ['run', '-t', 'upload', '--upload-port', board], firmwareDir, res);
      res.end(`\n[exit ${code}]\n`);
    }).finally(() => { flashing = false; });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(here, rel);
  if (!file.startsWith(here)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Video → OLED: http://localhost:${port}  (open in Chrome or Edge)`));
