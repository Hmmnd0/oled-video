# oled-video

Play videos on a **0.42" 72×40 OLED** attached to an **ESP32-C3**: stream them live from the browser with sound, or edit them and save them onto the board to play on their own.

- **Live:** the page plays the video, with sound, in Chrome. Every frame is shrunk to 72×40, dithered, and sent over USB in sync.
- **Saved:** encode an edit and write it into the board's flash. The board then plays it in a loop with no computer attached: about 2.9 MB, which is minutes of compressed video.
- **Editor:** a timeline with trimming, splitting, reordering, transitions, and per-clip picture settings.
- **Sources:** MP4, MOV and WebM directly; MKV, AVI, WMV and others via ffmpeg; YouTube links via tab sharing; any tab or window.

## What you need

**Hardware**
- An **ESP32-C3 board with a built-in 0.42" OLED**: the common "ESP32-C3 0.42 OLED" mini boards, with 4 MB of flash.
  - The display is on I2C **SDA = GPIO 5, SCL = GPIO 6**.
  - The **BOOT** button (GPIO 9) controls playback.
  - If your board is wired differently, change the pins at the top of `firmware/src/main.cpp`.
- A **USB-C data cable**. Many cables are charge-only and won't work; if the board never shows up, try another cable first.

**Software** (installation steps below)

| Tool | Why | Check it with |
|---|---|---|
| [Node.js](https://nodejs.org/) 18 or newer | runs the local web server | `node --version` |
| [PlatformIO Core](https://platformio.org/install/cli) | builds and uploads the board's firmware | `pio --version` |
| [Git](https://git-scm.com/) | downloads this project | `git --version` |
| [ffmpeg](https://ffmpeg.org/) (optional) | converts formats the browser can't play (MKV, AVI, WMV…) | `ffmpeg -version` |
| **Chrome** or **Edge** | the page talks to the board over USB with Web Serial, which Safari and Firefox don't have | |

The web server has no npm dependencies, so there's no `npm install` step.

## Installation

### macOS

1. Install [Homebrew](https://brew.sh) if you don't have it, by pasting this into Terminal:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. Install the tools:
   ```bash
   brew install node platformio git ffmpeg
   ```
3. No USB driver is needed: the ESP32-C3's built-in USB shows up as `/dev/cu.usbmodem…`.

### Windows 10 / 11

1. Open **PowerShell** and install the tools with winget:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   winget install Gyan.FFmpeg
   winget install Python.Python.3.12
   ```
2. **Close and reopen PowerShell** so the new tools are on your PATH, then install PlatformIO:
   ```powershell
   py -m pip install --user platformio
   ```
3. Check it with `pio --version`.
   - If `pio` isn't found, add the folder that pip printed a "not on PATH" warning about to your PATH, usually `%APPDATA%\Python\Python312\Scripts`. Do this in Settings → System → About → Advanced system settings → Environment Variables.
   - Then reopen PowerShell.
4. No USB driver is needed: Windows 10 and 11 include one for the ESP32-C3. The board appears as a **COM** port.

### Linux (Ubuntu / Debian)

1. Install the tools:
   ```bash
   sudo apt update
   sudo apt install git ffmpeg pipx curl
   pipx install platformio && pipx ensurepath
   ```
2. Install Node.js 18 or newer. Older Ubuntu releases ship an old version, so check `node --version`; if it's below 18, install the current LTS:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install nodejs
   ```
3. Allow your user to access the USB serial port, then **log out and back in**:
   ```bash
   sudo usermod -aG dialout $USER
   curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules | sudo tee /etc/udev/rules.d/99-platformio-udev.rules
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```
4. Use Chrome, Chromium or Edge. The board appears as `/dev/ttyACM0`.

## Getting started

### 1. Download the project

```bash
git clone https://github.com/Hmmnd0/oled-video.git
cd oled-video
```

### 2. (Optional) Pre-build the firmware

The first build downloads the ESP32 toolchain (a few hundred MB, 5–10 minutes). Doing it now means the first flash from the page is quick:

```bash
cd firmware
pio run
cd ..
```

It should end with `[SUCCESS]`.

### 3. Start the server

```bash
cd web
npm start
```

It prints `Video → OLED: http://localhost:8100`. Leave this window open while you use the page; **Ctrl+C** stops it. To use another port, run `PORT=8200 npm start` (on Windows PowerShell: `$env:PORT=8200; npm start`).

### 4. Open the page

Go to **http://localhost:8100** in **Chrome or Edge**.

### 5. Put the firmware on the board (once)

1. Plug the board in.
2. Click **Flash receiver**. A log window shows the build and upload, ending with `[SUCCESS]` and "Done".
3. The OLED then shows **"USB SCREEN / waiting for PC / no video saved"**.

You only need to do this once, or again after flashing something else onto the board. It re-divides the board's flash into 1 MB for the program and ~2.9 MB for video.

### 6. Connect and play

1. Click **Connect board** and choose the board in Chrome's list. It's named something like *USB JTAG/serial debug unit*, or `cu.usbmodem…` / `COM…` / `ttyACM…`. The page restarts the board and the status turns green.
2. **Open video files** (or drag them onto the page). Each becomes a clip on the timeline, and it plays with sound while the OLED mirrors it.
3. Adjust the picture in the **Picture** panel; the OLED preview shows exactly what the board shows.

### 7. Save a video onto the board

1. Click **Save to board** and choose a frame rate (12–24 fps is plenty).
2. The page encodes your whole edit, then uploads the firmware and the video. Your page disconnects from the board automatically while this happens.
3. When it says "Done", unplug the board and power it from any USB charger. It plays the video in a loop on its own.

On the board: **BOOT** pauses and resumes, and **holding BOOT for 1 s** restarts the video.

### Other sources

- **YouTube:** paste a link and click Load. When Chrome asks what to share, choose **this tab**. (See [YouTube](#youtube) below.)
- **Capture a tab or window…:** mirror anything else on screen.

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

## Troubleshooting

| Problem | Fix |
|---|---|
| The page says this browser has no Web Serial | Use **Chrome** or **Edge**. Safari and Firefox don't support it, and Brave turns it off by default. |
| "The board was not found on USB" | Try another USB cable (charge-only cables are very common), or another USB port. Close other programs using the board (Arduino IDE, serial monitors). Run `pio device list`: the board should appear with `VID:PID=303A`. |
| Upload fails with "Failed to connect" or "port is busy" | Click **Disconnect** on the page first. If it still fails, hold **BOOT**, unplug and re-plug the board, release BOOT, and try again. That forces it into upload mode. |
| OLED shows "USB SCREEN / waiting for PC" | That's the idle screen: the board is fine and waiting for frames. Connect the page and play a video. |
| OLED froze after clicking Connect board | The board landed in its upload mode. Press its **RST** button, or unplug and re-plug it. |
| OLED stays completely black | Your board may use different pins. Check the I2C pins at the top of `firmware/src/main.cpp`, then flash again. |
| `pio: command not found` | Reopen your terminal after installing. On Windows, see the PATH note above. |
| A video won't play or convert | Install **ffmpeg** (see Installation), then restart `npm start`. |
| "Too big for the board" when saving | Lower the frame rate, use **Black & white**, or use the **Ordered** or **None** dither, which compress much better. |
| Greys flicker | Use **Black & white**, which never flickers. |
| The page shows an old version after updating | Reload with **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows/Linux). |

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
