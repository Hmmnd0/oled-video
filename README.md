# oled-video

Play videos on a **0.42" 72×40 OLED** attached to an **ESP32-C3**: stream them live from the browser with sound, or edit them and save them onto the board to play on their own.

- **Live:** the page plays the video, with sound, in Chrome. Every frame is shrunk to 72×40, dithered, and sent over USB in sync.
- **Saved:** encode an edit and write it into the board's flash. The board then plays it in a loop with no computer attached: about 2.9 MB, which is minutes of compressed video.
- **Editor:** a timeline with trimming, splitting, reordering, transitions, and per-clip picture settings.
- **Sources:** MP4, MOV and WebM directly; MKV, AVI, WMV and others via ffmpeg; YouTube links via tab sharing; any tab or window.

## Hardware

An ESP32-C3 board with a built-in 0.42" SSD1306 OLED (the common "ESP32-C3 0.42 OLED" boards). The display is on I2C **SDA = GPIO 5, SCL = GPIO 6**, and **BOOT = GPIO 9** controls playback. Change the pins at the top of `firmware/src/main.cpp` if yours differ.

## Requirements

- [PlatformIO](https://platformio.org/) (`pio`) to build and upload the firmware
- Node.js 18 or newer for the local server
- Chrome or Edge, since live streaming uses Web Serial
- [ffmpeg](https://ffmpeg.org/), only for converting formats the browser can't play

## Quick start

```bash
cd web
npm start
```

Open **http://localhost:8100** in Chrome or Edge, then:

1. **Flash receiver**, once: builds and uploads the firmware. This re-divides the flash into 1 MB for the program and ~2.9 MB for video.
2. **Connect board** and pick the `usbmodem…` port.
3. **Open video files** or drop them on the page. Each becomes a clip on the timeline, and the OLED shows it live.
4. **Save to board** encodes the whole edit and writes it to the board, which then plays it on its own.

On the board: **BOOT** pauses and resumes, and **holding BOOT** for 1 s restarts the video.

## Editing

| | |
|---|---|
| Space | play / pause |
| ⏮ / Home | back to the beginning |
| Drag a clip | reorder |
| Drag a clip's edge | trim |
| S | split at the playhead |
| Del | delete the clip (the gap closes) |
| ← → (Shift) | step a frame (a second) |
| Scroll on the timeline | zoom |

- **Transitions:** click the **◆** between clips: cut, crossfade, fade through black, wipe, or **dither dissolve** (the picture switches over in OLED-pixel blocks, in a pattern).
- **Per-clip picture:** select a clip and the Picture panel edits just that clip: framing, dither, brightness, contrast, gamma, sharpen and invert. Shades (black and white or 4 greys) applies to the whole video.
- **The project is remembered** in the browser, video files included.

## Picture tips

- **Size:** the screen is tiny, so sharpening and contrast matter most.
- **Dither for saved videos:** use **Ordered** or **None**. Error-diffusion dithers (Atkinson, Floyd–Steinberg) look great live but barely compress, because their dot pattern changes completely every frame.
- **Greys:** **4 greys** flickers pixels to make greys; black and white has no flicker.

## YouTube

A page can't read pixels from the YouTube player, and downloading videos is against YouTube's terms. So the video plays in the embedded player, and Chrome asks to share **this tab**; the page crops out the player and streams that. Save to board needs a video file.

## How it works

**USB frames** (page → board):

| | |
|---|---|
| `0xA5 0x5A` + 360 bytes | 1-bit frame |
| `0xA5 0x5B` + flags + 720 bytes | 4-grey frame: low plane, high plane |

Planes are in SSD1306 page order: 5 pages × 72 columns, each byte 8 vertical pixels, least significant bit on top. The board reports `STATS <sub-frames/s> <frames/s>` once a second.

**4 greys:** the panel is black and white only. The firmware cycles three sub-frames as fast as I2C allows (~195/s at 1 MHz, one transfer per frame) and lights a pixel in 0–3 of them, with phases staggered per pixel to reduce visible pulsing.

**Saved video** (the `video` partition at `0x110000`):

- A 32-byte header: `OLV1`, width, height, planes, fps, frame count, byte count.
- Then per frame: `u16 length`, `u8 flags` (bit 0 = keyframe, otherwise XOR with the previous frame; bit 1 = stored uncompressed), then the payload.
- Payloads are raw deflate, decompressed with the inflate routine in the ESP32-C3's ROM.
- There's a keyframe every 2 seconds.

## Layout

```
web/        the page and local server (npm start)
  server.mjs   static files, ffmpeg conversion, firmware + video upload
  app.js       sources, picture pipeline, Web Serial, Save to board
  editor.js    timeline editor and composition
firmware/   PlatformIO project for the ESP32-C3 (player + live receiver)
```
