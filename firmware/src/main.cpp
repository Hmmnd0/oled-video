// Video player for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// Plays a video saved into the "video" flash partition by the Video -> OLED page,
// looping. BOOT button: press to pause/resume, hold for 1 s to restart.
//
// It's also a live screen: frames streamed over USB from the web page take over
// while they arrive, then the saved video resumes.
//   0xA5 0x5A + 360 bytes            1-bit frame
//   0xA5 0x5B + flags + 720 bytes    4-grey frame (low plane, high plane)
//
// Saved video format (little-endian), at the start of the partition:
//   "OLV1", u16 width, u16 height, u8 planes (1|2), u8 fps, u16 0, u32 frames, u32 bytes, 12 bytes 0
//   then per frame: u16 length, u8 flags (bit0 = keyframe, else XOR with previous;
//   bit1 = stored, else raw-deflate compressed), payload
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <esp_partition.h>
#include "esp32c3/rom/miniz.h"

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6
#define BOOT_BTN 9

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40, PLANE = W * H / 8;
const uint8_t OLED_ADDR = 0x3C, COL_OFFSET = 28;

uint8_t level[W * H];   // 0..3 per pixel
uint8_t phase[W * H];   // per-pixel flicker offset for greys
bool grey = false, scatter = true;
uint8_t sub = 0;

// ---------- drawing (one I2C transfer per frame; greys by cycling 3 sub-frames) ----------
void oledCommands(const uint8_t *cmds, size_t n) {
  Wire.beginTransmission(OLED_ADDR); Wire.write(0x00); Wire.write(cmds, n); Wire.endTransmission();
}
void pushFrame(const uint8_t *buf) {
  static const uint8_t window[] = {0x21, COL_OFFSET, COL_OFFSET + W - 1, 0x22, 0, H / 8 - 1};
  oledCommands(window, sizeof(window));
  Wire.beginTransmission(OLED_ADDR); Wire.write(0x40); Wire.write(buf, PLANE); Wire.endTransmission();
}
uint8_t subBuf[PLANE];
void renderSubframe() {
  for (int page = 0; page < H / 8; page++)
    for (int x = 0; x < W; x++) {
      uint8_t b = 0;
      for (int bit = 0; bit < 8; bit++) {
        int i = (page * 8 + bit) * W + x;
        uint8_t ph = scatter ? (sub + phase[i]) % 3 : sub;
        if (level[i] > ph) b |= 1 << bit;
      }
      subBuf[page * W + x] = b;
    }
  pushFrame(subBuf);
  sub = (sub + 1) % 3;
}
// planes -> per-pixel levels
void setLevels(const uint8_t *planes, int nPlanes) {
  for (int page = 0; page < H / 8; page++)
    for (int x = 0; x < W; x++) {
      uint8_t lo = planes[page * W + x], hi = nPlanes == 2 ? planes[PLANE + page * W + x] : lo;
      for (int bit = 0; bit < 8; bit++) level[(page * 8 + bit) * W + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  grey = nPlanes == 2;
  if (!grey) { sub = 0; renderSubframe(); }   // 1-bit: draw once
}

// ---------- saved video ----------
const esp_partition_t *part = nullptr;
struct { uint8_t planes, fps; uint32_t frames, bytes; } vid;
bool haveVideo = false, paused = false;
uint32_t vOffset, vFrame, vStartMs;
uint8_t vPlanes[PLANE * 2], rec[PLANE * 2 + 64], inflated[PLANE * 2];
static tinfl_decompressor inflator;   // ~11 KB: static, not on the small loop stack

bool loadHeader() {
  part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, (esp_partition_subtype_t)0x40, "video");
  if (!part) return false;
  uint8_t h[32];
  if (esp_partition_read(part, 0, h, sizeof(h)) != ESP_OK || memcmp(h, "OLV1", 4) != 0) return false;
  uint16_t w = h[4] | (h[5] << 8), hh = h[6] | (h[7] << 8);
  vid.planes = h[8]; vid.fps = h[9];
  vid.frames = h[12] | (h[13] << 8) | (h[14] << 16) | ((uint32_t)h[15] << 24);
  vid.bytes = h[16] | (h[17] << 8) | (h[18] << 16) | ((uint32_t)h[19] << 24);
  return w == W && hh == H && (vid.planes == 1 || vid.planes == 2) && vid.fps && vid.frames && vid.bytes + 32 <= part->size;
}
void restartVideo() { vOffset = 32; vFrame = 0; vStartMs = millis(); memset(vPlanes, 0, sizeof(vPlanes)); }

// Decode the next frame into vPlanes; false on a bad record
bool nextVideoFrame() {
  const int size = PLANE * vid.planes;
  if (vFrame >= vid.frames) restartVideo();
  uint8_t hdr[3];
  if (esp_partition_read(part, vOffset, hdr, 3) != ESP_OK) return false;
  uint16_t len = hdr[0] | (hdr[1] << 8);
  uint8_t flags = hdr[2];
  if (len > sizeof(rec) || esp_partition_read(part, vOffset + 3, rec, len) != ESP_OK) return false;
  const uint8_t *data = rec;
  if (!(flags & 2)) {
    tinfl_init(&inflator);
    size_t inSize = len, outSize = size;
    tinfl_status st = tinfl_decompress(&inflator, rec, &inSize, inflated, inflated, &outSize, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    if (st != TINFL_STATUS_DONE || outSize != (size_t)size) return false;
    data = inflated;
  } else if (len != size) return false;
  if (flags & 1) memcpy(vPlanes, data, size);
  else for (int i = 0; i < size; i++) vPlanes[i] ^= data[i];
  vOffset += 3 + len;
  vFrame++;
  return true;
}

// ---------- live frames over USB ----------
uint8_t body[PLANE * 2];
enum { WAIT_A5, WAIT_TYPE, WAIT_FLAGS, READ_BODY } rx = WAIT_A5;
uint8_t rxType = 0;
int need = 0, fill = 0;
uint32_t lastLive = 0;
bool live = false;

void readSerial() {
  while (Serial.available()) {
    if (rx == READ_BODY) {
      int n = Serial.read(body + fill, need - fill);
      if (n <= 0) break;
      fill += n;
      if (fill == need) { setLevels(body, rxType == 0x5B ? 2 : 1); lastLive = millis(); live = true; rx = WAIT_A5; }
      continue;
    }
    int b = Serial.read();
    if (rx == WAIT_A5) { if (b == 0xA5) rx = WAIT_TYPE; }
    else if (rx == WAIT_TYPE) {
      if (b == 0x5A) { rxType = b; need = PLANE; fill = 0; rx = READ_BODY; }
      else if (b == 0x5B) { rxType = b; rx = WAIT_FLAGS; }
      else rx = (b == 0xA5) ? WAIT_TYPE : WAIT_A5;
    } else if (rx == WAIT_FLAGS) { scatter = b & 1; need = PLANE * 2; fill = 0; rx = READ_BODY; }
  }
}

void drawIdle(uint32_t now) {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(11, 9, "USB SCREEN");
  u8g2.drawStr(1, 18, "waiting for PC");
  u8g2.drawStr(6, 27, "no video saved");
  int x = 6 + (now / 40) % 60;
  if ((now / 2400) % 2) x = 66 - (now / 40) % 60;
  u8g2.drawDisc(x, 35, 2);
  u8g2.sendBuffer();
}

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  pinMode(BOOT_BTN, INPUT_PULLUP);
  Wire.setBufferSize(PLANE + 8);
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(1000000);
  u8g2.begin();
  u8g2.setContrast(255);
  Wire.setClock(1000000);
  static const uint8_t fastOsc[] = {0xD5, 0xF0};
  oledCommands(fastOsc, sizeof(fastOsc));
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) phase[y * W + x] = (x + 2 * y) % 3;
  haveVideo = loadHeader();
  if (haveVideo) restartVideo();
}

void loop() {
  readSerial();
  uint32_t now = millis();
  if (live && now - lastLive > 1500) { live = false; if (haveVideo) vStartMs = now - (uint32_t)((uint64_t)vFrame * 1000 / vid.fps); }

  // BOOT: press = pause/resume, hold 1 s = restart
  static uint32_t downAt = 0; static bool held = false;
  bool btn = digitalRead(BOOT_BTN) == LOW;
  if (btn && !downAt) { downAt = now; held = false; }
  if (btn && downAt && !held && now - downAt > 1000 && haveVideo) { held = true; restartVideo(); paused = false; }
  if (!btn && downAt) {
    if (!held && now - downAt > 30) {
      paused = !paused;
      if (!paused && haveVideo) vStartMs = now - (uint32_t)((uint64_t)vFrame * 1000 / vid.fps);
    }
    downAt = 0;
  }

  if (!live) {
    if (!haveVideo) {
      static uint32_t lastIdle = 0;
      if (now - lastIdle > 33) { lastIdle = now; drawIdle(now); }
      return;
    }
    // Show the frame that's due (skipping ahead if we fell behind)
    if (!paused) {
      uint32_t due = (uint32_t)((uint64_t)(now - vStartMs) * vid.fps / 1000);
      bool changed = false;
      while (vFrame <= due && vFrame < vid.frames) {
        if (!nextVideoFrame()) { haveVideo = false; return; }
        changed = true;
      }
      if (vFrame >= vid.frames && due >= vid.frames) { restartVideo(); }   // loop
      if (changed) setLevels(vPlanes, vid.planes);
    }
  }
  if (grey) renderSubframe();   // greys need continuous cycling
}
