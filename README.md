# Multi-User Voice Meeting — SFU Architecture

A real-time multi-user voice meeting application built with **Node.js + WebSocket + WebCodecs + AudioWorklet**. Uses **SFU (Selective Forwarding Unit)** architecture for efficient multi-party audio relay.

**Key specs:** 48kHz capture → 8kHz codec · Opus @ 16kbps · 60ms frame · 8-frame jitter buffer · Linear interpolation resampling · Energy-based VAD · Browser-native (no third-party SDKs)

---

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:4001` in Chrome/Edge 86+.

---

## Usage

1. **Open the root URL** — the voice meeting page loads directly
2. **Click "📞 加入会议"** — microphone captures audio → Opus encoded → relayed via WebSocket SFU → decoded & played in real-time
3. **Click "🎤 麦克风开"** — toggle mute/unmute (listen-only mode)
4. **Click "❌ 退出会议"** — leave the call

---

## Admin Panel

Open `/admin` and enter the admin password to manage the service:

| Action | Description |
|--------|-------------|
| **View status** | Service on/off, active rooms, online users |
| **Stop service** | Disconnect all users, show maintenance page on root route |
| **Start service** | Restore normal operation |
| **Update codec config** | Change default codec parameters for new rooms |

> Default admin password: `admin123` (configured in `.env`)

---

## Features

- **SFU Multi-user** — unlimited participants per room; server only relays packets, no transcoding
- **VAD (Voice Activity Detection)** — energy-based silence detection; silent frames are skipped entirely (no encode, no send), saving 60–80% bandwidth
- **Speaker indicator** — green pulse animation when a participant is speaking
- **Mute/Unmute** — toggle microphone during a call (listen-only mode)
- **Online members list** — shows all connected participants with speaking indicators
- **Codec config sync** — first joiner's codec config is synced to late joiners via the server
- **Service maintenance** — admin can stop the service; root route shows a maintenance page
- **Admin API** — RESTful endpoints for service management and codec configuration

---

## How It Works

```
Microphone (48kHz)
  → AudioWorkletProcessor (PCM capture, 60ms frames)
    → VAD (RMS energy threshold: 0.008, hangover: 3 frames)
      → [if voice active] downsample (48kHz → 8kHz)
        → AudioEncoder (Opus @ 16kbps)
          → WebSocket SFU relay
            → AudioDecoder (Opus → PCM Float32)
              → upsample (8kHz → 48kHz)
                → AudioWorkletProcessor (mix all peers' audio)
                  → Speaker output
      → [if silent] skip entirely — no encode, no send
```

### Component Details

| Component | File | Role |
|-----------|------|------|
| **Capture + VAD** | `audio-worklet.js` | Captures microphone PCM in configurable frames; runs RMS energy detection per frame |
| **Encoder** | `client.js` | `AudioEncoder` (WebCodecs) encodes PCM → Opus; skips silent frames |
| **Network** | `server.js` | SFU relay: prepends sender ID to each packet, forwards to all other peers |
| **Decoder** | `client.js` | One `AudioDecoder` per peer; decodes Opus → PCM Float32 |
| **Playback Mixer** | `audio-worklet.js` | Ring buffers per peer; mixes all active peers' audio with gain normalization |

### SFU Packet Format

```
[senderIdLength(2B)][senderId(variable)][sampleRate(2B)][seq(2B)][timestamp(4B)][Opus data]
```

---

## Configuration

### `.env` (Server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4001` | Server HTTP/WS port |
| `ADMIN_PASSWORD` | `admin123` | Admin panel authentication |
| `CODEC_SAMPLE_RATE` | `8000` | Default Opus encode/decode sample rate (Hz) |
| `CODEC_BITRATE` | `16000` | Default Opus bitrate (bps) |
| `CODEC_FRAME_DURATION` | `0.06` | Default frame duration (seconds) |
| `CODEC_JITTER_BUFFER` | `8` | Default jitter buffer size (frames) |

### Codec Presets

| Preset | Sample Rate | Bitrate | Frame | Jitter Buffer | Use Case |
|--------|:-----------:|:-------:|:-----:|:-------------:|----------|
| 🚀 Low Latency | 48 kHz | 64 kbps | 20 ms | 2 frames | LAN / high-bandwidth |
| ⚖️ Balanced | 48 kHz | 32 kbps | 40 ms | 4 frames | General purpose |
| 🎵 High Quality | 48 kHz | 64 kbps | 40 ms | 2 frames | Music / presentations |
| 📡 Weak Network | 16 kHz | 16 kbps | 60 ms | 8 frames | Mobile / poor connection |

> **Default preset:** 📡 Weak Network (8kHz, 16kbps, 60ms, 8 frames) — optimized for stability

---

## Files

| File | Description |
|------|-------------|
| `server.js` | HTTP + WebSocket relay server with admin REST API |
| `public/index.html` | Voice meeting UI |
| `public/client.js` | Main client: WebSocket, WebCodecs encoder/decoder, AudioWorklet bridge, VAD handling, mute |
| `public/audio-worklet.js` | AudioWorkletProcessor: PCM capture, VAD (RMS energy), multi-peer playback mixer with ring buffers |
| `public/style.css` | Dark theme UI styles |
| `public/admin.html` | Admin panel page |
| `public/maintenance.html` | Service maintenance page |
| `.env` | Server configuration (port, admin password, codec defaults) |

---

## Deployment

### Option 1: Direct Run

```bash
git clone https://github.com/sonictl/node_voice_meeting.git
cd node_voice_meeting
npm install
# Edit .env to customize (optional)
npm start
```

### Option 2: Docker

```bash
docker build -t voice-meeting .
docker run -d \
  --name voice-meeting \
  -p 4001:4001 \
  -e PORT=4001 \
  -e ADMIN_PASSWORD=your-secure-password \
  voice-meeting
```

### Option 3: Docker Compose

```yaml
# docker-compose.yml
version: '3'
services:
  voice-meeting:
    build: .
    ports:
      - "4001:4001"
    environment:
      - PORT=4001
      - ADMIN_PASSWORD=your-secure-password
    restart: unless-stopped
```

```bash
docker-compose up -d
```

### Option 4: Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name voice.example.com;

    location / {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

### Option 5: Caddy Reverse Proxy (with auto TLS)

```caddy
voice.example.com {
    reverse_proxy 127.0.0.1:4001
}
```

Caddy automatically handles:
- **TLS/HTTPS** — automatic Let's Encrypt certificate provisioning and renewal
- **WebSocket** — transparent proxying without special configuration
- **HTTP/2 & HTTP/3** — enabled by default

---

## Tech Specs

| Metric | Value |
|--------|-------|
| **Audio** | Mono, Opus codec |
| **Capture sample rate** | 48 kHz (fixed, browser hardware) |
| **Codec sample rate** | Configurable (default: 8 kHz) |
| **Bandwidth per direction** | ~2 KB/s (16 kbps Opus) |
| **Bandwidth with VAD (silent)** | ~0.4 KB/s (only occasional keep-alive) |
| **Bandwidth savings (VAD)** | 60–80% during typical conversation |
| **End-to-end latency** | ~160ms jitter buffer + network RTT |
| **Resampling** | Linear interpolation (48kHz ↔ codec rate) |
| **Server dependencies** | `ws`, `uuid` |
| **Browser** | Chrome 86+ / Edge 86+ (WebCodecs required) |

### Browser Support

WebCodecs API is supported in:
- Chrome 86+
- Edge 86+
- Opera 72+
- Samsung Internet 15+

> **Note:** This application uses browser-native `AudioEncoder`/`AudioDecoder` (WebCodecs API). A compatible browser is required.

---

## Architecture Notes

### VAD Implementation

Voice Activity Detection is implemented in two layers:

1. **Detection** (`audio-worklet.js`): RMS energy is calculated per frame. If energy < threshold (0.008), the frame is classified as silent. A 3-frame hangover prevents clipping at speech boundaries.

2. **Decision** (`client.js`): When `hasVoice === false`, the frame is skipped entirely — no `encoder.encode()` call, no `sendAudioPacket()` call. This saves both CPU (encoding) and bandwidth (network).

### SFU vs MCU

This implementation uses **SFU (Selective Forwarding Unit)** rather than MCU (Multipoint Control Unit):
- **SFU**: Server forwards each sender's packets to all other participants. No transcoding. Lower CPU, higher bandwidth.
- **MCU**: Server decodes all streams, mixes them, and re-encodes. Higher CPU, lower bandwidth.

SFU is chosen for its scalability and simplicity with small-to-medium meeting rooms.

---

## License

MIT
