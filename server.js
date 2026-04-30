// =============================================
// WebSocket + WebCodecs 语音中继服务器
// 路由: / → 语音会议页面, /admin → 管理后台
// =============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// =============================================
// .env 配置加载
// =============================================
function loadEnv() {
    const envFile = path.join(__dirname, '.env');
    const config = {
        PORT: 4001,
        ADMIN_PASSWORD: 'admin123'
    };
    try {
        const content = fs.readFileSync(envFile, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key in config) {
                config[key] = isNaN(Number(val)) ? val : Number(val);
            }
        }
    } catch (err) {
        console.log('[ENV] No .env file found, using defaults');
    }
    return config;
}

const ENV = loadEnv();
const PORT = ENV.PORT;
const ADMIN_PASSWORD = String(ENV.ADMIN_PASSWORD);

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
    '.json': 'application/json'
};

// =============================================
// 服务开关状态
// =============================================
let serviceOn = true;

// =============================================
// HTTP 静态文件服务器
// =============================================
const server = http.createServer((req, res) => {
    const url = req.url;

    // ---- 根路由: 直接返回语音会议页面 ----
    if (url === '/') {
        if (!serviceOn) {
            serveMaintenancePage(res);
            return;
        }
        serveIndexPage(res);
        return;
    }

    // ---- /admin 管理后台 ----
    if (url === '/admin') {
        serveAdminPage(res);
        return;
    }

    // ---- /admin/api/* API 接口 ----
    if (url.startsWith('/admin/api/')) {
        handleAdminAPI(req, res);
        return;
    }

    // ---- 静态文件服务 ----
    serveStaticFile(url, res);
});

// =============================================
// 页面服务函数
// =============================================
function serveIndexPage(res) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, 'utf-8', (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }
        const injected = data.replace(
            '</head>',
            `<script>window.__ROOM_ID__ = ${JSON.stringify('default')};</script>\n</head>`
        );
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        });
        res.end(injected);
    });
}

function serveMaintenancePage(res) {
    const filePath = path.join(__dirname, 'public', 'maintenance.html');
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
}

function serveAdminPage(res) {
    const filePath = path.join(__dirname, 'public', 'admin.html');
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
}

function serveStaticFile(url, res) {
    const cleanUrl = url.split('?')[0];
    const ext = path.extname(cleanUrl);

    if (!MIME_TYPES[ext]) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    let filePath = path.join(__dirname, 'public', cleanUrl);

    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        });
        res.end(data);
    });
}

// =============================================
// Admin API 处理
// =============================================
function handleAdminAPI(req, res) {
    const url = req.url;

    function jsonResponse(statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(data));
    }

    // ---- 认证 ----
    if (url === '/admin/api/auth' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === ADMIN_PASSWORD) {
                    jsonResponse(200, { ok: true });
                } else {
                    jsonResponse(200, { ok: false, message: '密码错误' });
                }
            } catch (e) {
                jsonResponse(400, { ok: false, message: '请求格式错误' });
            }
        });
        return;
    }

    // ---- 获取状态 ----
    if (url === '/admin/api/status') {
        jsonResponse(200, {
            serviceOn,
            address: `http://localhost:${PORT}`,
            rooms: rooms.size,
            peers: peers.size
        });
        return;
    }

    // ---- 关闭服务 ----
    if (url === '/admin/api/stop' && req.method === 'POST') {
        if (!serviceOn) {
            jsonResponse(200, { ok: false, message: '服务已经关闭' });
            return;
        }
        serviceOn = false;

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1001, '服务维护中');
            }
        });

        rooms.clear();
        peers.clear();

        console.log('[ADMIN] Service stopped by admin');
        jsonResponse(200, { ok: true, message: '服务已关闭' });
        return;
    }

    // ---- 开启服务 ----
    if (url === '/admin/api/start' && req.method === 'POST') {
        if (serviceOn) {
            jsonResponse(200, { ok: false, message: '服务已经开启' });
            return;
        }
        serviceOn = true;
        console.log('[ADMIN] Service started by admin');
        jsonResponse(200, { ok: true, message: '服务已开启' });
        return;
    }

    jsonResponse(404, { ok: false, message: '未知 API' });
}

// =============================================
// WebSocket 服务器
// =============================================
const WebSocket = require('ws');
const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024
});

// =============================================
// 默认编解码配置
// =============================================
const DEFAULT_CODEC_CONFIG = {
    sampleRate: 48000,
    frameDuration: 0.04,
    opusBitrate: 32000,
    jitterBufferFrames: 4
};

// =============================================
// 房间状态
// =============================================
const rooms = new Map();   // roomId -> { peers: Set<peerId>, codecConfig: {} }
const peers = new Map();   // peerId -> { ws, roomId }

// =============================================
// WebSocket 事件处理
// =============================================
wss.on('connection', (ws) => {
    let peerId = null;
    let roomId = null;

    // ---- 检查服务是否开启 ----
    if (!serviceOn) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '语音会议服务维护中...'
        }));
        ws.close(1001, '服务维护中');
        return;
    }

    // ---- 消息处理 ----
    ws.on('message', (data, isBinary) => {
        try {
            if (isBinary) {
                handleBinaryMessage(ws, peerId, roomId, data);
            } else {
                const msg = JSON.parse(data.toString());
                switch (msg.type) {
                    case 'join':
                        ({ peerId, roomId } = handleJoin(ws, msg, peerId, roomId));
                        break;
                    case 'leave':
                        handleLeave(ws, peerId, roomId);
                        peerId = null;
                        roomId = null;
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
                        break;
                }
            }
        } catch (err) {
            console.error(`[WS] Error: ${err.message}`);
        }
    });

    // ---- 断开连接 ----
    ws.on('close', () => {
        if (peerId && roomId) {
            handleLeave(ws, peerId, roomId);
        }
    });

    ws.on('error', () => {
        if (peerId && roomId) {
            handleLeave(ws, peerId, roomId);
        }
    });
});

// =============================================
// 加入房间
// =============================================
function handleJoin(ws, msg, oldPeerId, oldRoomId) {
    // 先离开旧房间
    if (oldPeerId && oldRoomId) {
        handleLeave(ws, oldPeerId, oldRoomId);
    }

    const newPeerId = msg.peerId || uuidv4().slice(0, 4);
    const newRoomId = msg.roomId || 'default';

    // 确保 peerId 在房间内唯一
    const finalPeerId = ensureUniquePeerId(newRoomId, newPeerId);

    // 创建房间（如果不存在），使用发起方的编解码配置
    if (!rooms.has(newRoomId)) {
        const userConfig = msg.codecConfig || {};
        const roomConfig = { ...DEFAULT_CODEC_CONFIG, ...userConfig };
        rooms.set(newRoomId, { peers: new Set(), codecConfig: roomConfig });
        console.log(`[CONFIG] Room "${newRoomId}" codec config:`, roomConfig);
    }

    const room = rooms.get(newRoomId);
    room.peers.add(finalPeerId);
    peers.set(finalPeerId, { ws, roomId: newRoomId });

    // 获取房间内其他 peer 列表
    const existingPeers = Array.from(room.peers).filter(id => id !== finalPeerId);

    // 回复加入成功
    ws.send(JSON.stringify({
        type: 'joined',
        peerId: finalPeerId,
        roomId: newRoomId,
        peers: existingPeers,
        codecConfig: room.codecConfig
    }));

    // 通知房间内其他 peer
    broadcastToRoom(newRoomId, {
        type: 'peer_joined',
        peerId: finalPeerId
    }, finalPeerId);

    console.log(`[JOIN] Peer "${finalPeerId}" joined room "${newRoomId}" (${room.peers.size} peers)`);

    return { peerId: finalPeerId, roomId: newRoomId };
}

function ensureUniquePeerId(roomId, baseId) {
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(baseId)) return baseId;

    let counter = 1;
    while (room.peers.has(`${baseId}_${counter}`)) {
        counter++;
    }
    return `${baseId}_${counter}`;
}

// =============================================
// 离开房间
// =============================================
function handleLeave(ws, peerId, roomId) {
    if (!peerId || !roomId) return;

    const room = rooms.get(roomId);
    if (room) {
        room.peers.delete(peerId);

        broadcastToRoom(roomId, {
            type: 'peer_left',
            peerId
        }, peerId);

        console.log(`[LEAVE] Peer "${peerId}" left room "${roomId}" (${room.peers.size} peers remain)`);
    }

    peers.delete(peerId);
}

// =============================================
// 二进制音频数据中继 (SFU模式)
// =============================================
function handleBinaryMessage(ws, peerId, roomId, data) {
    if (!peerId || !roomId) {
        console.warn('[BINARY] Received from unregistered peer');
        return;
    }

    const senderId = peerId;
    const senderIdBytes = new TextEncoder().encode(senderId);
    const senderIdLength = senderIdBytes.length;

    const extendedPacket = new Uint8Array(2 + senderIdLength + data.length);
    const view = new DataView(extendedPacket.buffer);

    view.setUint16(0, senderIdLength, true);
    extendedPacket.set(senderIdBytes, 2);
    extendedPacket.set(data, 2 + senderIdLength);

    broadcastBinaryToRoom(roomId, extendedPacket, peerId);
}

// =============================================
// 广播
// =============================================
function broadcastToRoom(roomId, message, excludePeerId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const jsonStr = JSON.stringify(message);

    for (const pid of room.peers) {
        if (pid === excludePeerId) continue;
        const peer = peers.get(pid);
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(jsonStr);
        }
    }
}

function broadcastBinaryToRoom(roomId, data, excludePeerId) {
    const room = rooms.get(roomId);
    if (!room) return;

    for (const pid of room.peers) {
        if (pid === excludePeerId) continue;
        const peer = peers.get(pid);
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(data);
        }
    }
}

// =============================================
// 健康检查：定期清理断开的连接
// =============================================
setInterval(() => {
    for (const [pid, peer] of peers) {
        if (peer.ws.readyState !== WebSocket.OPEN) {
            const room = rooms.get(peer.roomId);
            if (room) {
                room.peers.delete(pid);
                broadcastToRoom(peer.roomId, { type: 'peer_left', peerId: pid }, pid);
            }
            peers.delete(pid);
            console.log(`[CLEANUP] Removed stale peer "${pid}"`);
        }
    }
}, 30000);

// =============================================
// 启动
// =============================================
server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════');
    console.log('  WebSocket + WebCodecs Voice Relay (SFU)');
    console.log(`  Voice:  http://localhost:${PORT}`);
    console.log(`  Admin:  http://localhost:${PORT}/admin`);
    console.log(`  WS:     ws://localhost:${PORT}`);
    console.log(`  Default Codec: Opus ${DEFAULT_CODEC_CONFIG.opusBitrate/1000}kbps @ ${DEFAULT_CODEC_CONFIG.sampleRate/1000}kHz`);
    console.log(`  Service: ${serviceOn ? 'ON' : 'OFF'}`);
    console.log('═══════════════════════════════════════════');
    console.log('[READY] Multi-room SFU WebCodecs Opus relay running');
});
