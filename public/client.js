// =============================================
// WebSocket + WebCodecs 语音客户端
// 浏览器原生编解码 · 零依赖 · 超低延迟
// 架构: 48kHz采集 → 降采样8kHz → Opus编码 → WS → 服务器中继 → WS → Opus解码8kHz → 升采样48kHz → 播放
// 编解码参数从服务器获取（管理员可在后台配置）
// v1.0 - 基础功能实现，经测试，3人通话有一点可以接受的延迟。
// =============================================

const VOICE_APP = (() => {
    'use strict';

    // =============================================
    // 基础配置（客户端固定，不可通过服务器修改）
    // =============================================
    const CONFIG = {
        serverUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`,
        roomId: window.__ROOM_ID__ || 'default',
        captureSampleRate: 48000    // 浏览器硬件采集采样率（固定48kHz，不可变）
    };

    // ---- 编解码参数（从服务器获取，动态更新） ----
    let codecConfig = {
        sampleRate: 8000,           // 默认8kHz，加入房间后由服务器下发覆盖
        frameDuration: 0.06,        // 默认60ms
        opusBitrate: 16000,         // 默认16kbps
        jitterBufferFrames: 8       // 默认8帧
    };

    // =============================================
    // 重采样函数（线性插值）
    // =============================================

    /**
     * 降采样：从高采样率到低采样率
     * @param {Float32Array} input - 输入 PCM 数据
     * @param {number} fromRate - 输入采样率
     * @param {number} toRate - 输出采样率
     * @returns {Float32Array} 降采样后的 PCM 数据
     */
    function downsample(input, fromRate, toRate) {
        if (fromRate === toRate) return input;
        const ratio = fromRate / toRate;
        const outputLength = Math.floor(input.length / ratio);
        const output = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            const srcIdx = i * ratio;
            const idx0 = Math.floor(srcIdx);
            const idx1 = Math.min(idx0 + 1, input.length - 1);
            const frac = srcIdx - idx0;
            output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
        }
        return output;
    }

    /**
     * 升采样：从低采样率到高采样率
     * @param {Float32Array} input - 输入 PCM 数据
     * @param {number} fromRate - 输入采样率
     * @param {number} toRate - 输出采样率
     * @returns {Float32Array} 升采样后的 PCM 数据
     */
    function upsample(input, fromRate, toRate) {
        if (fromRate === toRate) return input;
        const ratio = toRate / fromRate;
        const outputLength = Math.round(input.length * ratio);
        const output = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            const srcIdx = i / ratio;
            const idx0 = Math.floor(srcIdx);
            const idx1 = Math.min(idx0 + 1, input.length - 1);
            const frac = srcIdx - idx0;
            output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
        }
        return output;
    }

    // =============================================
    // 状态
    // =============================================
    let ws = null;
    let audioCtx = null;
    let workletNode = null;
    let mediaStream = null;
    let micSource = null;

    let encoder = null;
    let peerDecoders = new Map(); // SFU: decoders per peer

    let myPeerId = null;
    let roomPeers = new Map();
    let seqCounter = 0;

    let gainNode = null;

    // 丢包统计
    let stats = {
        packetsSent: 0,
        packetsRecv: 0,
        packetsLost: 0,
        bytesSent: 0,
        bytesRecv: 0,
        lastSeqReceived: new Map()
    };

    let isInitializing = false;
    let isJoined = false;
    let isMuted = false; // 麦克风静音状态

    // UI 元素
    let statusEl, peersListEl, debugInfoEl, myPeerIdEl, roomStatusEl, roomIdDisplayEl;
    let muteBtnEl;

    // =============================================
    // 房间状态管理 (SFU: 支持多用户)
    // =============================================
    function updateRoomStatus() {
        if (!roomStatusEl) return;
        const peerCount = roomPeers.size + (isJoined ? 1 : 0);

        if (!isJoined) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">☎️ 未加入会议.</span>';
        } else if (peerCount === 1) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">⏳ 等待其他人加入...</span>';
        } else {
            roomStatusEl.innerHTML = `<span class="room-status active">🟢 多人会议中... (${peerCount}人)</span>`;
        }
    }

    // =============================================
    // WebSocket 连接
    // =============================================
    function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            ws = new WebSocket(CONFIG.serverUrl);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                console.log('[WS] Connected');
                setStatus('🟢 已连接', '#4caf50');
                resolve();
            };

            ws.onerror = (err) => {
                console.error('[WS] Error:', err);
                if (!isJoined) reject(new Error('WebSocket connection failed'));
            };

            ws.onclose = () => {
                console.log('[WS] Disconnected');
                if (isJoined) {
                    setStatus('🔴 连接断开，5秒后重连...', '#d16969');
                    setTimeout(() => reconnect(), 5000);
                } else {
                    setStatus('🔴 断开连接', '#d16969');
                }
            };

            ws.onmessage = handleMessage;
        });
    }

    // =============================================
    // 消息处理
    // =============================================
    function handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            handleAudioPacket(new Uint8Array(event.data));
            return;
        }

        try {
            const msg = JSON.parse(event.data);
            handleSignal(msg);
        } catch (e) {
            console.warn('[WS] Invalid message:', e);
        }
    }

    function handleSignal(msg) {
        switch (msg.type) {
            case 'joined':
                myPeerId = msg.peerId;
                myPeerIdEl.textContent = myPeerId;
                isJoined = true;
                setStatus(`🎙️ 已加入多人会议 (${msg.roomId})`, '#4caf50');

                // 从服务器获取编解码配置
                if (msg.codecConfig) {
                    applyServerConfig(msg.codecConfig);
                }

                if (msg.peers && msg.peers.length > 0) {
                    msg.peers.forEach(pid => addPeer(pid));
                }
                updateRoomStatus();
                updatePeerInfoSection();
                updateDebugInfo();
                break;

            case 'peer_joined':
                addPeer(msg.peerId);
                updateDebugInfo();
                break;

            case 'peer_left':
                removePeer(msg.peerId);
                stats.lastSeqReceived.delete(msg.peerId);
                updateDebugInfo();
                break;

            case 'pong':
                break;

            case 'error':
                console.error('[Server]', msg.message);
                setStatus(`⚠️ ${msg.message}`, '#ffa500');
                break;
        }
    }

    // =============================================
    // 应用服务器下发的编解码配置
    // =============================================
    function applyServerConfig(serverConfig) {
        if (!serverConfig) return;

        if (serverConfig.sampleRate) codecConfig.sampleRate = serverConfig.sampleRate;
        if (serverConfig.opusBitrate) codecConfig.opusBitrate = serverConfig.opusBitrate;
        if (serverConfig.frameDuration) codecConfig.frameDuration = serverConfig.frameDuration;
        if (serverConfig.jitterBufferFrames) codecConfig.jitterBufferFrames = serverConfig.jitterBufferFrames;

        console.log('[Config] Applied server config:', codecConfig);

        // 更新 UI 上的参数显示
        updateCodecParamsDisplay();
    }

    /**
     * 更新页面上的编解码参数显示
     */
    function updateCodecParamsDisplay() {
        const paramItems = document.querySelectorAll('.param-item');
        if (!paramItems.length) return;

        // 按顺序更新: 编解码采样率、比特率、帧长、抖动缓冲、重采样、RMS阈值
        const values = [
            `${codecConfig.sampleRate / 1000} kHz`,
            `${codecConfig.opusBitrate / 1000} kbps`,
            `${(codecConfig.frameDuration * 1000).toFixed(0)} ms`,
            `${codecConfig.jitterBufferFrames} 帧 (~${(codecConfig.jitterBufferFrames * codecConfig.frameDuration * 1000).toFixed(0)}ms)`,
            `${CONFIG.captureSampleRate / 1000}kHz ↔ ${codecConfig.sampleRate / 1000}kHz 线性插值`,
            '0.015'
        ];

        paramItems.forEach((item, index) => {
            if (index < values.length) {
                const valueEl = item.querySelector('.param-value');
                if (valueEl) valueEl.textContent = values[index];
            }
        });
    }

    // =============================================
    // 发送音频帧到服务器
    // =============================================
    function sendAudioPacket(opusData) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!opusData || opusData.length === 0) return; // 不发送空包

        // 构建二进制包: [采样率2B][序号2B][时间戳4B][Opus数据]
        const headerSize = 8;
        const packet = new ArrayBuffer(headerSize + opusData.length);
        const view = new DataView(packet);
        const seq = seqCounter++;

        view.setUint16(0, codecConfig.sampleRate, true); // 使用服务器下发的编解码采样率
        view.setUint16(2, seq, true);
        view.setUint32(4, Date.now(), true);

        const opusBytes = new Uint8Array(packet, headerSize, opusData.length);
        opusBytes.set(opusData);

        ws.send(packet);
        stats.packetsSent++;
        stats.bytesSent += packet.byteLength;
    }

    // =============================================
    // 说话人指示器状态
    // =============================================
    let speakerActivity = new Map(); // peerId -> { lastActiveTime, energy }
    const SPEAKER_TIMEOUT_MS = 300; // 300ms 保持定时器避免闪烁

    /**
     * 更新说话人指示器
     * 在解码输出时调用，记录该 peer 最近有音频活动
     */
    function updateSpeakerActivity(peerId) {
        speakerActivity.set(peerId, Date.now());
        updateSpeakerIndicators();
    }

    /**
     * 定期检查说话人状态，更新 UI
     */
    function updateSpeakerIndicators() {
        const now = Date.now();
        for (const [pid, peerData] of roomPeers) {
            const lastActive = speakerActivity.get(pid) || 0;
            const isSpeaking = (now - lastActive) < SPEAKER_TIMEOUT_MS;
            const peerEl = document.getElementById(`peer-${pid}`);
            if (peerEl) {
                const statusSpan = peerEl.querySelector('.peer-status');
                if (statusSpan) {
                    if (isSpeaking) {
                        statusSpan.innerHTML = '🔊 说话中';
                        statusSpan.className = 'peer-status speaking';
                        peerEl.classList.add('speaking');
                    } else {
                        statusSpan.innerHTML = '🟢 在线';
                        statusSpan.className = 'peer-status';
                        peerEl.classList.remove('speaking');
                    }
                }
            }
        }
    }

    // 每秒检查一次说话人状态
    setInterval(() => {
        if (isJoined) updateSpeakerIndicators();
    }, 300);

    // =============================================
    // Peer 管理
    // =============================================
    function addPeer(peerId) {
        if (peerId === myPeerId) return;
        if (roomPeers.has(peerId)) return;
        roomPeers.set(peerId, { firstSeq: -1, lastPacketTime: 0 });
        speakerActivity.set(peerId, 0);
        addPeerToList(peerId);
        updatePeerInfoSection();
        updateRoomStatus();
        console.log(`[PEER] ${peerId} joined`);
    }

    function removePeer(peerId) {
        roomPeers.delete(peerId);
        speakerActivity.delete(peerId);

        // SFU: 清理此peer的解码器
        if (peerDecoders.has(peerId)) {
            const decoder = peerDecoders.get(peerId);
            if (decoder.state === 'configured') {
                decoder.close();
            }
            peerDecoders.delete(peerId);
            console.log(`[PEER] Cleaned up decoder for ${peerId}`);
        }

        removePeerFromList(peerId);
        updatePeerInfoSection();
        updateRoomStatus();
        console.log(`[PEER] ${peerId} left`);
    }

    // =============================================
    // 成员列表显示
    // =============================================
    function updatePeerInfoSection() {
        // 成员列表由 addPeerToList / removePeerFromList 维护
    }

    // =============================================
    // 音频初始化
    // =============================================
    async function initAudio() {
        if (audioCtx) return;

        audioCtx = new AudioContext({
            sampleRate: CONFIG.captureSampleRate, // 固定48kHz
            latencyHint: 'interactive'
        });

        // 加载 AudioWorklet
        await audioCtx.audioWorklet.addModule('/audio-worklet.js?v=2');

        // 创建 Worklet 节点
        workletNode = new AudioWorkletNode(audioCtx, 'voice-worklet');

        // 通知 Worklet 当前编解码参数（帧长等）
        workletNode.port.postMessage({
            type: 'config',
            frameDuration: codecConfig.frameDuration,
            sampleRate: CONFIG.captureSampleRate,
            jitterBufferFrames: codecConfig.jitterBufferFrames
        });

        // 监听 Worklet 消息
        workletNode.port.onmessage = async (event) => {
            const data = event.data;

            if (data.type === 'pcm') {
                // 收到麦克风 PCM（48kHz）→ 降采样 → 编码 → 发送
                if (!encoder || encoder.state !== 'configured') return;

                // VAD: 如果检测到静音且没有挂起，跳过编码和发送
                if (data.hasVoice === false) {
                    return; // 静音帧：不编码、不发送，节省带宽
                }

                // 降采样: 48kHz → 服务器下发的编解码采样率
                const downsampled = downsample(data.data, CONFIG.captureSampleRate, codecConfig.sampleRate);

                const audioData = new AudioData({
                    format: 'f32-planar',
                    sampleRate: codecConfig.sampleRate,
                    numberOfFrames: downsampled.length,
                    numberOfChannels: 1,
                    timestamp: performance.now() * 1000,
                    data: downsampled
                });

                encoder.encode(audioData);
                audioData.close();
            }

            if (data.type === 'underrun') {
                console.warn('[Playback] Buffer underrun');
            }
        };

        // 增益控制
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.0;

        // 连接: Worklet → Gain → 扬声器
        workletNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        console.log(`[Audio] Initialized: ${CONFIG.captureSampleRate}Hz capture, ${codecConfig.sampleRate}Hz codec`);
    }

    // =============================================
    // 麦克风启动
    // =============================================
    async function startMicrophone() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: { ideal: CONFIG.captureSampleRate }
                }
            });

            micSource = audioCtx.createMediaStreamSource(mediaStream);
            micSource.connect(workletNode);

            console.log('[Mic] Started');
            return true;
        } catch (err) {
            console.error('[Mic] Error:', err);
            setStatus('⚠️ 麦克风权限被拒绝', '#ffa500');
            throw err;
        }
    }

    // =============================================
    // WebCodecs 编解码器初始化（使用服务器下发的参数）
    // =============================================
    async function initCodec() {
        if (!window.AudioEncoder || !window.AudioDecoder) {
            throw new Error('浏览器不支持 WebCodecs API');
        }

        // 检查 Opus 编码支持
        const encSupported = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: codecConfig.sampleRate,
            numberOfChannels: 1
        });
        if (!encSupported.supported) {
            throw new Error(`浏览器不支持 Opus 编码 @ ${codecConfig.sampleRate}Hz`);
        }
        console.log(`[Codec] Opus encoding supported @ ${codecConfig.sampleRate}Hz`);

        // 检查 Opus 解码支持
        const decSupported = await AudioDecoder.isConfigSupported({
            codec: 'opus',
            sampleRate: codecConfig.sampleRate,
            numberOfChannels: 1
        });
        if (!decSupported.supported) {
            throw new Error(`浏览器不支持 Opus 解码 @ ${codecConfig.sampleRate}Hz`);
        }
        console.log(`[Codec] Opus decoding supported @ ${codecConfig.sampleRate}Hz`);

        // ---- 编码器 ----
        encoder = new AudioEncoder({
            output: (chunk) => {
                // 编码完成 → 直接发送
                const opusData = new Uint8Array(chunk.byteLength);
                chunk.copyTo(opusData);
                console.log(`[Send] seq=${seqCounter}, opusLen=${opusData.length}, ts=${Date.now()}`);
                sendAudioPacket(opusData);
            },
            error: (e) => {
                console.error('[Encoder] Error:', e.message);
            }
        });

        encoder.configure({
            codec: 'opus',
            sampleRate: codecConfig.sampleRate,
            numberOfChannels: 1,
            bitrate: codecConfig.opusBitrate
        });

        console.log(`[Encoder] state=${encoder.state}, config: ${codecConfig.sampleRate}Hz, ${codecConfig.opusBitrate}bps`);

        // ---- 解码器 ----
        // SFU: Decoders created per peer, not globally
        console.log('[Codec] WebCodecs Encoder ready (decoders created per peer)');
    }

    // =============================================
    // SFU: 为每个peer创建解码器
    // =============================================
    function createPeerDecoder(peerId) {
        const decoder = new AudioDecoder({
            output: (audioData) => {
                // 解码完成 → 升采样到48kHz → 发送 PCM 到 Worklet 播放
                if (workletNode) {
                    // 获取解码器实际输出的采样率（Opus 内部可能输出48kHz而非配置的8kHz）
                    const decodedSampleRate = audioData.sampleRate;
                    const decodedFrames = audioData.numberOfFrames;
                    const decodedDurationMs = (decodedFrames / decodedSampleRate) * 1000;

                    console.log(`[Decode:${peerId}] decoded: ${decodedFrames}frames@${decodedSampleRate}Hz (${decodedDurationMs.toFixed(1)}ms), config: ${codecConfig.sampleRate}Hz`);

                    // 正确提取 PCM 数据
                    const copyOptions = {
                        planeIndex: 0,
                        frameOffset: 0,
                        frameCount: decodedFrames
                    };
                    const bufferSize = audioData.allocationSize(copyOptions);
                    const pcmDecoded = new Float32Array(bufferSize / Float32Array.BYTES_PER_ELEMENT);
                    audioData.copyTo(pcmDecoded, copyOptions);

                    let pcmForPlayback;

                    if (decodedSampleRate === CONFIG.captureSampleRate) {
                        // 解码器已输出48kHz → 直接使用，无需升采样
                        pcmForPlayback = pcmDecoded;
                        console.log(`[Decode:${peerId}] already ${decodedSampleRate}Hz, using directly: ${pcmForPlayback.length}samples`);
                    } else if (decodedSampleRate < CONFIG.captureSampleRate) {
                        // 解码器输出低于48kHz（如8kHz）→ 需要升采样
                        pcmForPlayback = upsample(pcmDecoded, decodedSampleRate, CONFIG.captureSampleRate);
                        console.log(`[Decode:${peerId}] upsample ${decodedSampleRate}→${CONFIG.captureSampleRate}Hz: ${pcmDecoded.length}→${pcmForPlayback.length}samples`);
                    } else {
                        // 解码器输出高于48kHz → 需要降采样
                        pcmForPlayback = downsample(pcmDecoded, decodedSampleRate, CONFIG.captureSampleRate);
                        console.log(`[Decode:${peerId}] downsample ${decodedSampleRate}→${CONFIG.captureSampleRate}Hz: ${pcmDecoded.length}→${pcmForPlayback.length}samples`);
                    }

                    workletNode.port.postMessage({
                        type: 'pcm',
                        peerId: peerId,
                        data: pcmForPlayback
                    });
                    // 说话人指示器：解码到音频数据说明此 peer 正在说话
                    updateSpeakerActivity(peerId);
                }
                audioData.close();
            },
            error: (e) => {
                console.error(`[Decoder:${peerId}] Error:`, e.message);
            }
        });

        decoder.configure({
            codec: 'opus',
            sampleRate: codecConfig.sampleRate,
            numberOfChannels: 1
        });

        console.log(`[Decoder:${peerId}] state=${decoder.state}, config: ${codecConfig.sampleRate}Hz`);
        return decoder;
    }

    // =============================================
    // 加入会议房间
    // =============================================
    async function joinRoom() {
        if (isInitializing) return;
        isInitializing = true;

        try {
            setStatus('🔄 连接信令服务器...', '#888');
            await connectWebSocket();

            setStatus('🔄 加入多人会议房间...', '#888');

            // 发送 join 请求（不携带编解码参数，由服务器决定）
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: null
            }));

            // 等待 joined 消息，获取服务器下发的编解码配置
            const roomConfig = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('加入超时')), 10000);
                const origHandler = ws.onmessage;
                ws.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) return;
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'joined') {
                            clearTimeout(timeout);
                            ws.onmessage = origHandler;
                            // 先应用服务器配置，再处理 joined 消息
                            if (msg.codecConfig) {
                                applyServerConfig(msg.codecConfig);
                            }
                            handleSignal(msg);
                            resolve(msg.codecConfig);
                        } else if (msg.type === 'error') {
                            clearTimeout(timeout);
                            ws.onmessage = origHandler;
                            reject(new Error(msg.message));
                        }
                    } catch(e) {}
                };
            });

            setStatus('🔄 初始化 WebCodecs 编解码器...', '#888');
            await initCodec();

            setStatus('🔄 初始化音频系统...', '#888');
            await initAudio();

            setStatus('🔄 启动麦克风...', '#888');
            await startMicrophone();

            document.getElementById('joinBtn').disabled = true;
            document.getElementById('joinBtn').textContent = '✅ 已加入';
            document.getElementById('leaveBtn').disabled = false;

            // 显示麦克风控制按钮
            if (muteBtnEl) {
                muteBtnEl.style.display = '';
                muteBtnEl.disabled = false;
                muteBtnEl.textContent = '🎤 麦克风开';
                muteBtnEl.className = 'btn-mute';
            }

            startStatsUpdater();

        } catch (err) {
            console.error('[Join] Error:', err);
            setStatus(`❌ 加入失败: ${err.message}`, '#d16969');
            cleanup();
        } finally {
            isInitializing = false;
        }
    }

    // =============================================
    // 麦克风静音/取消静音
    // =============================================
    function toggleMute() {
        if (!audioCtx || !workletNode || !micSource) return;

        isMuted = !isMuted;

        if (isMuted) {
            // 静音：断开麦克风与 Worklet 的连接，停止采集
            try { micSource.disconnect(workletNode); } catch(e) {}
            if (muteBtnEl) {
                muteBtnEl.textContent = '🔇 麦克风关';
                muteBtnEl.className = 'btn-mute muted';
            }
            setStatus('🔇 麦克风已静音，仅收听', '#ffa500');
            console.log('[Mic] Muted');
        } else {
            // 取消静音：重新连接麦克风到 Worklet
            micSource.connect(workletNode);
            if (muteBtnEl) {
                muteBtnEl.textContent = '🎤 麦克风开';
                muteBtnEl.className = 'btn-mute';
            }
            setStatus('🎙️ 麦克风已开启', '#4caf50');
            console.log('[Mic] Unmuted');
        }
    }

    // =============================================
    // 离开会议房间
    // =============================================
    function leaveRoom() {
        if (ws && isJoined) {
            ws.send(JSON.stringify({ type: 'leave' }));
        }
        cleanup();
        setStatus('⚡ 当前状态：未加入会议房间', '#d4d4d4');
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('joinBtn').textContent = '📞 加入会议';
        document.getElementById('leaveBtn').disabled = true;
        const peersListEl2 = document.getElementById('peersList');
        if (peersListEl2) {
            peersListEl2.innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }

        // 隐藏麦克风控制按钮
        if (muteBtnEl) muteBtnEl.style.display = 'none';
        isMuted = false;
    }

    // =============================================
    // 断线重连（5秒）
    // =============================================
    async function reconnect() {
        if (isInitializing) return;
        try {
            isJoined = false;
            ws = null;

            // 清理旧状态：关闭所有解码器，清空 peer 列表
            for (const [pid, decoder] of peerDecoders) {
                if (decoder.state !== 'closed') decoder.close();
            }
            peerDecoders.clear();
            roomPeers.clear();
            speakerActivity.clear();
            stats.lastSeqReceived.clear();

            await connectWebSocket();
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: myPeerId
            }));
            setStatus('🟢 已重连', '#4caf50');
        } catch (err) {
            console.error('[Reconnect] Failed:', err);
            setStatus('🔴 重连失败', '#d16969');
            setTimeout(() => reconnect(), 5000);
        }
    }

    // =============================================
    // 清理
    // =============================================
    function cleanup() {
        isJoined = false;

        if (encoder) {
            if (encoder.state !== 'closed') encoder.close();
            encoder = null;
        }
        // SFU: 清理所有peer解码器
        for (const [peerId, decoder] of peerDecoders) {
            if (decoder.state !== 'closed') decoder.close();
        }
        peerDecoders.clear();
        if (workletNode) {
            workletNode.port.postMessage({ type: 'reset' });
            workletNode.disconnect();
            workletNode = null;
        }
        if (gainNode) {
            gainNode.disconnect();
            gainNode = null;
        }
        if (micSource) {
            micSource.disconnect();
            micSource = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioCtx) {
            audioCtx.close().catch(() => {});
            audioCtx = null;
        }
        if (ws) {
            ws.onclose = null;
            ws.close();
            ws = null;
        }

        stats = {
            packetsSent: 0, packetsRecv: 0, packetsLost: 0,
            bytesSent: 0, bytesRecv: 0,
            lastSeqReceived: new Map()
        };

        // 清理后统一更新 UI 状态
        roomPeers.clear();
        updateRoomStatus();
        updatePeerInfoSection();
    }

    // =============================================
    // SFU: 多用户音频包处理
    // =============================================
    function handleAudioPacket(data) {
        // SFU 数据包格式: [发送者ID长度2B][发送者ID字节][采样率2B][序号2B][时间戳4B][Opus数据]
        if (data.length <= 10) return; // 没有音频数据

        let offset = 0;
        const senderIdLength = (data[offset] | (data[offset + 1] << 8));
        offset += 2;
        const senderId = new TextDecoder().decode(data.subarray(offset, offset + senderIdLength));
        offset += senderIdLength;

        // 跳过发送者ID，获取原始音频包
        const audioData = data.subarray(offset);
        if (audioData.length <= 8) return; // 只有头部没有数据

        // 解析头部
        const sampleRate = audioData[0] | (audioData[1] << 8);
        const packetSeq = audioData[2] | (audioData[3] << 8);
        const timestamp = (audioData[4] | (audioData[5] << 8) | (audioData[6] << 16) | (audioData[7] << 24)) >>> 0;
        const opusData = audioData.subarray(8);

        // 跳过空数据包
        if (opusData.length === 0) return;

        stats.packetsRecv++;
        stats.bytesRecv += data.length;

        console.log(`[Recv:${senderId}] seq=${packetSeq}, opusLen=${opusData.length}, ts=${timestamp}`);

        // 获取或创建此peer的解码器
        let decoder = peerDecoders.get(senderId);
        if (!decoder) {
            decoder = createPeerDecoder(senderId);
            peerDecoders.set(senderId, decoder);
        }

        if (decoder.state !== 'configured') return;

        // 创建 EncodedAudioChunk 解码
        const chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestamp * 1000,
            duration: codecConfig.frameDuration * 1_000_000,
            data: opusData
        });

        decoder.decode(chunk);
    }

    // =============================================
    // UI 辅助函数
    // =============================================
    function setStatus(text, color) {
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
    }

    function addPeerToList(peerId) {
        if (!peersListEl) return;
        const emptyMsg = peersListEl.querySelector('span[style*="color:#666"]');
        if (emptyMsg) emptyMsg.remove();

        const peerDiv = document.createElement('div');
        peerDiv.id = `peer-${peerId}`;
        peerDiv.className = 'peer-item';
        peerDiv.innerHTML = `
            <span class="peer-id">👤 ${peerId}</span>
            <span class="peer-status">🟢 在线</span>
        `;
        peersListEl.appendChild(peerDiv);
    }

    function removePeerFromList(peerId) {
        if (!peersListEl) return;
        const peerDiv = document.getElementById(`peer-${peerId}`);
        if (peerDiv) peerDiv.remove();
        if (peersListEl.children.length === 0) {
            peersListEl.innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }
    }

    function startStatsUpdater() {
        setInterval(() => {
            if (isJoined) updateDebugInfo();
        }, 1000);
    }

    function updateDebugInfo() {
        const panel = document.getElementById('debugPanel');
        const info = document.getElementById('debugInfo');
        if (!panel || !info) return;

        panel.style.display = 'block';

        const bitrateSend = stats.packetsSent > 0
            ? ((stats.bytesSent * 8) / (stats.packetsSent * codecConfig.frameDuration) / 1000).toFixed(1)
            : '0';

        info.innerHTML = `
            <span>🆔 ID: ${myPeerId || '—'}</span><br>
            <span>👥 房间: ${roomPeers.size + (myPeerId ? 1 : 0)} 人</span><br>
            <span>📤 发送: ${stats.packetsSent} 包 | ${bitrateSend}kbps</span><br>
            <span>📥 接收: ${stats.packetsRecv} 包</span><br>
            <span>📊 编码: Opus ${codecConfig.opusBitrate/1000}kbps | ${codecConfig.frameDuration * 1000}ms/帧 | ${codecConfig.sampleRate/1000}kHz</span><br>
            <span>📐 重采样: 48kHz↔${codecConfig.sampleRate/1000}kHz 线性插值</span>
        `;
    }

    // =============================================
    // 初始化
    // =============================================
    function init() {
        statusEl = document.getElementById('status');
        peersListEl = document.getElementById('peersList');
        myPeerIdEl = document.getElementById('myPeerId');
        roomStatusEl = document.getElementById('roomStatus');
        roomIdDisplayEl = document.getElementById('roomIdDisplay');

        document.getElementById('joinBtn').onclick = joinRoom;
        document.getElementById('leaveBtn').onclick = leaveRoom;
        muteBtnEl = document.getElementById('muteBtn');
        if (muteBtnEl) {
            muteBtnEl.onclick = toggleMute;
        }

        // 显示当前房间ID
        if (roomIdDisplayEl) {
            roomIdDisplayEl.textContent = CONFIG.roomId;
        }

        updateRoomStatus();

        console.log(`[VoiceApp] Ready - Room: ${CONFIG.roomId}, params from server`);
        setStatus('⚡ 点击下方按钮加入语音会议', '#d4d4d4');
    }

    return { init, joinRoom, leaveRoom };
})();

window.onload = () => VOICE_APP.init();
