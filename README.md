# Multi-User Voice Chat - SFU Implementation

A Node.js implemented multi-user web voice chat app using SFU (Selective Forwarding Unit) architecture. Tech: WebSocket + WebCodecs (AudioEncoder/AudioDecoder) + AudioWorklet.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:4001` — directly enter the voice meeting room. Share the URL to invite multiple participants.

## Usage

1. **Open `http://localhost:4001`** — directly enter the voice meeting page
2. **Choose codec preset** (optional) — 🚀 Low Latency / ⚖️ Balanced / 🎵 High Quality / 📡 Weak Network
3. **Click "📞 加入通话"** — audio encoded with Opus, relayed via WebSocket SFU, decoded in real-time
4. **Click "🎤 麦克风开"** to mute/unmute microphone (listen-only mode)
5. **Click "❌ 退出通话"** to end the call

> **Note**: First joiner decides the codec config. Late joiners auto-sync and use the room's unified config.

## Admin Panel

Open `http://localhost:4001/admin` — enter the admin password to manage the service:

- **View status**: service on/off, active rooms, online users
- **Stop service**: disconnect all users, show maintenance page on root route
- **Start service**: restore normal operation

Configure the admin password in `.env` (`ADMIN_PASSWORD=admin123` by default).

## Features

- **Root route** — `http://localhost:4001` directly opens the voice meeting page
- **Admin panel** — `/admin` for password-protected service management
- **Mute/Unmute** — toggle microphone on/off during a call (listen-only mode)
- **Online members list** — shows all connected participants with speaking indicators
- **VAD (Voice Activity Detection)** — silent frames are not encoded or sent, saving 60-80% bandwidth
- **Speaker indicator** — green pulse animation when a participant is speaking
- **Codec config sync** — first joiner's config synced to late joiners via server
- **SFU Multi-user** — unlimited participants per room with efficient server bandwidth usage
- **Service maintenance** — when service is stopped, root route shows maintenance page

## How It Works

```
Microphone → AudioWorklet (PCM capture) → VAD → AudioEncoder (Opus) → WebSocket SFU → AudioDecoder (Opus) → AudioWorklet (Mix) → Speaker
```

- **Capture**: `AudioWorkletProcessor` captures microphone PCM in configurable frames
- **VAD**: Energy-based voice activity detection — silent frames are skipped
- **Encoder**: `AudioEncoder` (WebCodecs) encodes PCM → Opus
- **Network**: SFU packet format [senderIdLength(2B)][senderId][sampleRate(2B)][seq(2B)][timestamp(4B)][Opus] over WebSocket
- **Decoder**: `AudioDecoder` (WebCodecs) decodes Opus → PCM Float32 (one decoder per participant)
- **Playback**: AudioWorklet mixes audio from all participants with separate ring buffers
- **Server**: SFU relay - forwards packets to all participants except sender, minimal processing

## Configuration

### `.env` (server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4001 | Server port |
| `ADMIN_PASSWORD` | admin123 | Admin panel password |

### Codec Presets (client UI)

| Preset | Sample Rate | Bitrate | Frame | Jitter |
|--------|:-----------:|:-------:|:-----:|:------:|
| 🚀 Low Latency | 48 kHz | 64 kbps | 20 ms | 2 frames |
| ⚖️ Balanced | 48 kHz | 32 kbps | 40 ms | 4 frames |
| 🎵 High Quality | 48 kHz | 64 kbps | 40 ms | 2 frames |
| 📡 Weak Network | 16 kHz | 16 kbps | 60 ms | 8 frames |

## Files

| File | Description |
|------|-------------|
| `server.js` | HTTP + WebSocket relay server with admin API |
| `public/index.html` | Voice meeting UI |
| `public/client.js` | Main client: WebSocket, WebCodecs, AudioWorklet, VAD, mute |
| `public/audio-worklet.js` | AudioWorkletProcessor for PCM capture, playback & VAD |
| `public/style.css` | Dark theme UI styles |
| `public/admin.html` | Admin panel page |
| `public/maintenance.html` | Service maintenance page |
| `.env` | Server configuration |

## Deployment

### Option 1: Direct Run (Simple)

```bash
# Clone the repo
git clone https://github.com/sonictl/node_voice_meeting.git
cd node_voice_meeting

# Install dependencies
npm install

# Configure (optional)
# Edit .env to set PORT and ADMIN_PASSWORD

# Start server
npm start
```

### Option 2: Docker Deployment

```bash
# Build image
docker build -t voice-meeting .

# Run container
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

### Option 4: Production with Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/voice-meeting
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

### Option 5: Production with Caddy Reverse Proxy

```caddy
# Caddyfile
voice.example.com {
    reverse_proxy 127.0.0.1:4001 {
        # WebSocket support (Caddy handles this automatically)
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
```

Caddy automatically handles:
- **TLS/HTTPS** — automatic Let's Encrypt certificate provisioning and renewal
- **WebSocket** — transparent WebSocket proxying without special configuration
- **HTTP/2 & HTTP/3** — enabled by default

To use with a local `.env` file for the admin password:

```caddy
# Caddyfile with environment variable
voice.example.com {
    reverse_proxy 127.0.0.1:4001
}
```

```bash
# Run Caddy
caddy run --config Caddyfile
```

## Tech Specs

- **Audio**: Mono, Opus, configurable sample rate & bitrate
- **Bandwidth**: ~4 KB/s per direction (balanced preset), ~1 KB/s with VAD (silent)
- **Latency**: ~160ms jitter buffer + network RTT (balanced preset)
- **Dependencies**: `ws` (server), `uuid` (server)
- **Browser**: Chrome 86+ / Edge 86+ (WebCodecs required)

## Browser Support

WebCodecs API is supported in:
- Chrome 86+
- Edge 86+
- Opera 72+
- Samsung Internet 15+

> **Note**: Uses browser-native `AudioEncoder`/`AudioDecoder`. No WASM binaries or external codec libraries required.
