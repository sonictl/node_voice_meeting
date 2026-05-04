// =============================================
// WebSocket + WebCodecs 语音中继服务器 (SFU 单房间多人)
// 路由: / → 语音会议页面, /admin → 管理后台
// =============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// =============================================
// .env 配置加载
// =============================================
function loadEnv() {
    const envFile = path.join(__dirname, '.env');
    const config = {
        PORT: 4001,
        ADMIN_PASSWORD: 'admin123',
        CODEC_SAMPLE_RATE: 8000,
        CODEC_BITRATE: 16000,
        CODEC_FRAME_DURATION: 0.06,
        CODEC_JITTER_BUFFER: 8
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
// 安全模块
// =============================================

// ---- Session 存储（内存中） ----
const sessions = new Map(); // sessionToken -> { createdAt, ip }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24小时过期

// ---- 速率限制 ----
const rateLimitMap = new Map(); // ip -> { count, resetTime }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分钟窗口
const RATE_LIMIT_MAX_LOGIN = 5;          // 登录：5次/分钟/IP
const RATE_LIMIT_MAX_API = 30;           // 管理API：30次/分钟/IP

// ---- CSRF Token 存储 ----
const csrfTokens = new Map(); // sessionToken -> csrfToken

// ---- 审计日志 ----
const auditLog = [];

/**
 * 生成随机 Session Token
 */
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成 CSRF Token
 */
function generateCsrfToken() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * 清理过期 Session
 */
function cleanupSessions() {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (now - session.createdAt > SESSION_TTL_MS) {
            sessions.delete(token);
            csrfTokens.delete(token);
        }
    }
}
setInterval(cleanupSessions, 60 * 60 * 1000); // 每小时清理一次

/**
 * 速率限制检查
 * @param {string} ip - 客户端 IP
 * @param {number} maxRequests - 最大请求数
 * @returns {boolean} true 表示允许，false 表示被限制
 */
function checkRateLimit(ip, maxRequests) {
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    
    if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
        rateLimitMap.set(ip, entry);
    }
    
    entry.count++;
    return entry.count <= maxRequests;
}

/**
 * 清理过期的速率限制记录
 */
function cleanupRateLimits() {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetTime) {
            rateLimitMap.delete(ip);
        }
    }
}
setInterval(cleanupRateLimits, 60 * 1000); // 每分钟清理一次

/**
 * 获取客户端 IP
 */
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.socket.remoteAddress || 
           'unknown';
}

/**
 * 验证 Session Token
 * @returns {object|null} 如果有效返回 session 对象，否则返回 null
 */
function validateSession(req) {
    // 从 Cookie 或 Authorization Header 获取 Token
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = Object.fromEntries(
        cookieHeader.split(';').filter(Boolean).map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, v.join('=')];
        })
    );
    
    let token = cookies['admin_session'];
    
    // 如果没有 Cookie，尝试从 Authorization Header 获取
    if (!token) {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
    }
    
    if (!token) return null;
    
    const session = sessions.get(token);
    if (!session) return null;
    
    // 检查是否过期
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        csrfTokens.delete(token);
        return null;
    }
    
    return { token, ...session };
}

/**
 * 验证 CSRF Token
 */
function validateCsrfToken(req, sessionToken) {
    const csrfToken = csrfTokens.get(sessionToken);
    if (!csrfToken) return false;
    
    // 从请求体或 Header 获取 CSRF Token
    const bodyCsrf = req.bodyCsrf || '';
    const headerCsrf = req.headers['x-csrf-token'] || '';
    
    return bodyCsrf === csrfToken || headerCsrf === csrfToken;
}

/**
 * 添加审计日志
 */
function addAuditLog(action, ip, details = '') {
    const entry = {
        timestamp: new Date().toISOString(),
        action,
        ip,
        details
    };
    auditLog.push(entry);
    console.log(`[AUDIT] ${entry.timestamp} | ${action} | IP: ${ip} | ${details}`);
    
    // 只保留最近 1000 条日志
    if (auditLog.length > 1000) {
        auditLog.splice(0, auditLog.length - 1000);
    }
}

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
        serveAdminPage(req, res);
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

function serveAdminPage(req, res) {
    const filePath = path.join(__dirname, 'public', 'admin.html');
    fs.readFile(filePath, 'utf-8', (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }
        
        // 检查是否有有效的 Session（用于页面加载时注入 CSRF Token）
        const session = validateSession(req);
        let csrfToken = '';
        if (session) {
            csrfToken = csrfTokens.get(session.token) || '';
        }
        
        // 注入 CSRF Token 到页面
        const injected = data.replace(
            '</head>',
            `<script>window.__CSRF_TOKEN__ = ${JSON.stringify(csrfToken)};</script>\n</head>`
        );
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(injected);
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
    const clientIP = getClientIP(req);

    function jsonResponse(statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'null' // 不允许跨域
        });
        res.end(JSON.stringify(data));
    }

    // ---- 认证 ----
    if (url === '/admin/api/auth' && req.method === 'POST') {
        // 速率限制：登录接口
        if (!checkRateLimit(`login:${clientIP}`, RATE_LIMIT_MAX_LOGIN)) {
            addAuditLog('LOGIN_RATE_LIMITED', clientIP, 'Too many login attempts');
            return jsonResponse(429, { ok: false, message: '登录尝试过于频繁，请稍后再试' });
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === ADMIN_PASSWORD) {
                    // 生成 Session Token
                    const token = generateSessionToken();
                    sessions.set(token, { createdAt: Date.now(), ip: clientIP });
                    
                    // 生成 CSRF Token
                    const csrfToken = generateCsrfToken();
                    csrfTokens.set(token, csrfToken);
                    
                    addAuditLog('LOGIN_SUCCESS', clientIP, 'Admin login successful');
                    
                    // 设置 Cookie
                    res.setHeader('Set-Cookie', [
                        `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
                        `X-CSRF-Token=${csrfToken}; SameSite=Strict; Path=/`
                    ]);
                    
                    jsonResponse(200, { ok: true, csrfToken });
                } else {
                    addAuditLog('LOGIN_FAILED', clientIP, 'Wrong password');
                    jsonResponse(200, { ok: false, message: '密码错误' });
                }
            } catch (e) {
                jsonResponse(400, { ok: false, message: '请求格式错误' });
            }
        });
        return;
    }

    // ---- 登出 ----
    if (url === '/admin/api/logout' && req.method === 'POST') {
        const session = validateSession(req);
        if (session) {
            sessions.delete(session.token);
            csrfTokens.delete(session.token);
            addAuditLog('LOGOUT', clientIP, 'Admin logged out');
        }
        
        // 清除 Cookie
        res.setHeader('Set-Cookie', [
            'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
            'X-CSRF-Token=; SameSite=Strict; Path=/; Max-Age=0'
        ]);
        
        jsonResponse(200, { ok: true });
        return;
    }

    // ---- 以下所有 API 需要认证 ----
    const session = validateSession(req);
    if (!session) {
        addAuditLog('API_UNAUTHORIZED', clientIP, `Unauthorized access to ${url}`);
        return jsonResponse(401, { ok: false, message: '未授权，请先登录' });
    }

    // ---- 速率限制：管理 API ----
    if (!checkRateLimit(`api:${clientIP}`, RATE_LIMIT_MAX_API)) {
        addAuditLog('API_RATE_LIMITED', clientIP, `Rate limited on ${url}`);
        return jsonResponse(429, { ok: false, message: '请求过于频繁，请稍后再试' });
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

    // ---- 关闭服务（需要 CSRF 验证） ----
    if (url === '/admin/api/stop' && req.method === 'POST') {
        // 读取请求体以获取 CSRF Token
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                req.bodyCsrf = parsed._csrf;
            } catch (e) {}
            
            if (!validateCsrfToken(req, session.token)) {
                addAuditLog('CSRF_FAILED', clientIP, 'CSRF token validation failed for stop');
                return jsonResponse(403, { ok: false, message: 'CSRF 验证失败' });
            }
            
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

            addAuditLog('SERVICE_STOP', clientIP, 'Service stopped by admin');
            console.log('[ADMIN] Service stopped by admin');
            jsonResponse(200, { ok: true, message: '服务已关闭' });
        });
        return;
    }

    // ---- 开启服务（需要 CSRF 验证） ----
    if (url === '/admin/api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                req.bodyCsrf = parsed._csrf;
            } catch (e) {}
            
            if (!validateCsrfToken(req, session.token)) {
                addAuditLog('CSRF_FAILED', clientIP, 'CSRF token validation failed for start');
                return jsonResponse(403, { ok: false, message: 'CSRF 验证失败' });
            }
            
            if (serviceOn) {
                jsonResponse(200, { ok: false, message: '服务已经开启' });
                return;
            }
            serviceOn = true;
            addAuditLog('SERVICE_START', clientIP, 'Service started by admin');
            console.log('[ADMIN] Service started by admin');
            jsonResponse(200, { ok: true, message: '服务已开启' });
        });
        return;
    }

    // ---- 获取当前编解码配置 ----
    if (url === '/admin/api/codec-config' && req.method === 'GET') {
        jsonResponse(200, { ...DEFAULT_CODEC_CONFIG });
        return;
    }

    // ---- 更新默认编解码配置（需要 CSRF 验证） ----
    if (url === '/admin/api/codec-config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                req.bodyCsrf = config._csrf;
                
                if (!validateCsrfToken(req, session.token)) {
                    addAuditLog('CSRF_FAILED', clientIP, 'CSRF token validation failed for codec-config');
                    return jsonResponse(403, { ok: false, message: 'CSRF 验证失败' });
                }
                
                // 输入验证：检查参数范围
                const validSampleRates = [8000, 16000, 24000, 48000];
                const validBitrates = [8000, 16000, 32000, 64000];
                const validFrameDurations = [0.02, 0.04, 0.06, 0.12];
                const validJitterBuffers = [2, 4, 6, 8];
                
                if (config.sampleRate && !validSampleRates.includes(config.sampleRate)) {
                    return jsonResponse(400, { ok: false, message: '无效的采样率' });
                }
                if (config.opusBitrate && !validBitrates.includes(config.opusBitrate)) {
                    return jsonResponse(400, { ok: false, message: '无效的比特率' });
                }
                if (config.frameDuration && !validFrameDurations.includes(config.frameDuration)) {
                    return jsonResponse(400, { ok: false, message: '无效的帧长' });
                }
                if (config.jitterBufferFrames && !validJitterBuffers.includes(config.jitterBufferFrames)) {
                    return jsonResponse(400, { ok: false, message: '无效的抖动缓冲帧数' });
                }
                
                if (config.sampleRate) DEFAULT_CODEC_CONFIG.sampleRate = config.sampleRate;
                if (config.opusBitrate) DEFAULT_CODEC_CONFIG.opusBitrate = config.opusBitrate;
                if (config.frameDuration) DEFAULT_CODEC_CONFIG.frameDuration = config.frameDuration;
                if (config.jitterBufferFrames) DEFAULT_CODEC_CONFIG.jitterBufferFrames = config.jitterBufferFrames;
                
                addAuditLog('CODEC_CONFIG_UPDATE', clientIP, 
                    `Updated: sampleRate=${DEFAULT_CODEC_CONFIG.sampleRate}, bitrate=${DEFAULT_CODEC_CONFIG.opusBitrate}, frameDuration=${DEFAULT_CODEC_CONFIG.frameDuration}, jitter=${DEFAULT_CODEC_CONFIG.jitterBufferFrames}`);
                console.log('[ADMIN] Default codec config updated:', DEFAULT_CODEC_CONFIG);
                jsonResponse(200, { ok: true, message: '配置已更新' });
            } catch (e) {
                jsonResponse(400, { ok: false, message: '请求格式错误' });
            }
        });
        return;
    }

    // ---- 获取审计日志（需要 CSRF 验证） ----
    if (url === '/admin/api/audit-log' && req.method === 'GET') {
        jsonResponse(200, { logs: auditLog.slice(-50) }); // 返回最近50条
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
// 默认编解码配置（从 .env 读取，管理员可在 /admin 页面动态修改）
// =============================================
const DEFAULT_CODEC_CONFIG = {
    sampleRate: ENV.CODEC_SAMPLE_RATE,
    frameDuration: ENV.CODEC_FRAME_DURATION,
    opusBitrate: ENV.CODEC_BITRATE,
    jitterBufferFrames: ENV.CODEC_JITTER_BUFFER
};

// =============================================
// 房间状态
// =============================================
const rooms = new Map();   // roomId -> { peers: Set<peerId>, codecConfig: {} }
const peers = new Map();   // peerId -> { ws, roomId }

// =============================================
// WebSocket 事件处理
// =============================================
wss.on('connection', (ws, req) => {
    let peerId = null;
    let roomId = null;
    const wsClientIP = getClientIP(req);

    // ---- 检查服务是否开启 ----
    if (!serviceOn) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '语音会议服务维护中...'
        }));
        ws.close(1001, '服务维护中');
        return;
    }

    addAuditLog('WS_CONNECT', wsClientIP, 'WebSocket connected');

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
                        if (peerId && roomId) {
                            addAuditLog('PEER_JOIN', wsClientIP, `Peer "${peerId}" joined room "${roomId}"`);
                        }
                        break;
                    case 'leave':
                        if (peerId && roomId) {
                            addAuditLog('PEER_LEAVE', wsClientIP, `Peer "${peerId}" left room "${roomId}"`);
                        }
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
            addAuditLog('WS_DISCONNECT', wsClientIP, `Peer "${peerId}" disconnected from room "${roomId}"`);
            handleLeave(ws, peerId, roomId);
        } else {
            addAuditLog('WS_DISCONNECT', wsClientIP, 'WebSocket disconnected (unregistered)');
        }
    });

    ws.on('error', () => {
        if (peerId && roomId) {
            handleLeave(ws, peerId, roomId);
        }
    });
});

// =============================================
// 房间空置自动清理
// =============================================
function cleanupEmptyRooms() {
    for (const [roomId, room] of rooms) {
        if (room.peers.size === 0) {
            rooms.delete(roomId);
            console.log(`[CLEANUP] Removed empty room "${roomId}"`);
        }
    }
}

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
// 健康检查：定期清理断开的连接 + 空房间
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
    // 清理空房间
    cleanupEmptyRooms();
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
    console.log('[READY] SFU Meeting WebCodecs Opus relay running');
});
