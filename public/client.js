// =============================================
// WebSocket + WebCodecs 语音客户端
// 浏览器原生编解码 · 零依赖 · 超低延迟
// =============================================

const VOICE_APP = (() => {
    'use strict';

    // =============================================
    // 配置
    // =============================================
    // 从 URL 路径获取房间 ID（由服务端注入到 window.__ROOM_ID__）
    const ROOM_ID = window.__ROOM_ID__ || 'default';
    const CONFIG = {
        serverUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`,
        roomId: ROOM_ID,
        sampleRate: 48000,       // 48kHz 足够语音
        frameDuration: 0.04,     // 40ms 帧长
        opusBitrate: 32000,      // 32kbps 语音最优
        jitterBufferFrames: 4    // 4 帧抖动缓冲 (~160ms)
    };

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
    let configSectionEl, roomConfigInfoEl, roomConfigDetailsEl;
    let configSampleRateEl, configBitrateEl, configFrameDurationEl, configJitterEl;
    let muteBtnEl;

    // =============================================
    // 房间状态管理 (SFU: 支持多用户)
    // =============================================
    function updateRoomStatus() {
        if (!roomStatusEl) return;
        const peerCount = roomPeers.size + (isJoined ? 1 : 0);

        if (!isJoined) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">☎️ 未加入通话...</span>';
        } else if (peerCount === 1) {
            roomStatusEl.innerHTML = '<span class="room-status waiting">⏳ 等待其他人加入...</span>';
        } else {
            roomStatusEl.innerHTML = `<span class="room-status active">🟢 多人通话中 (${peerCount}人)</span>`;
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
                    setStatus('🔴 连接断开，3秒后重连...', '#d16969');
                    setTimeout(() => reconnect(), 3000);
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
                setStatus(`🎙️ 已加入多人通话房间 (${msg.roomId})`, '#4caf50');

                // 应用服务端下发的编解码配置
                if (msg.codecConfig) {
                    applyRoomConfig(msg.codecConfig);
                }

                // 如果房间已有其他成员，说明配置已由先加入者决定，隐藏配置面板
                if (msg.peers && msg.peers.length > 0 && configSectionEl) {
                    configSectionEl.style.display = 'none';
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
                // 如果是房间已满错误，恢复按钮状态
                if (msg.message.includes('通话房间已满')) {
                    document.getElementById('joinBtn').disabled = false;
                    document.getElementById('joinBtn').textContent = '📞 加入通话';
                    document.getElementById('leaveBtn').disabled = true;
                    cleanup();
                }
                break;
        }
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

        view.setUint16(0, CONFIG.sampleRate, true);
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
    const SPEAKER_TIMEOUT_MS = 800; // 超过此时间无音频则视为停止说话

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
        // 此函数仅用于触发 UI 更新
    }

    // =============================================
    // 音频初始化
    // =============================================
    async function initAudio() {
        if (audioCtx) return;

        audioCtx = new AudioContext({
            sampleRate: CONFIG.sampleRate,
            latencyHint: 'interactive'
        });

        // 加载 AudioWorklet
        await audioCtx.audioWorklet.addModule('/audio-worklet.js?v=1');

        // 创建 Worklet 节点
        workletNode = new AudioWorkletNode(audioCtx, 'voice-worklet');

        // 监听 Worklet 消息
        workletNode.port.onmessage = async (event) => {
            const data = event.data;

            if (data.type === 'pcm') {
                // VAD: 如果检测到静音且没有挂起，跳过编码和发送
                if (data.hasVoice === false) {
                    // 静音帧：不编码、不发送，节省带宽
                    return;
                }

                // 收到麦克风 PCM → 编码 → 发送
                if (!encoder || encoder.state !== 'configured') return;

                const audioData = new AudioData({
                    format: 'f32-planar',
                    sampleRate: CONFIG.sampleRate,
                    numberOfFrames: data.data.length,
                    numberOfChannels: 1,
                    timestamp: performance.now() * 1000,
                    data: data.data
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

        console.log(`[Audio] Initialized: ${CONFIG.sampleRate}Hz`);
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
                    sampleRate: { ideal: CONFIG.sampleRate }
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
    // WebCodecs 编解码器初始化
    // =============================================
    async function initCodec() {
        if (!window.AudioEncoder || !window.AudioDecoder) {
            throw new Error('浏览器不支持 WebCodecs API');
        }

        // 检查 Opus 编码支持
        const encSupported = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });
        if (!encSupported.supported) {
            throw new Error('浏览器不支持 Opus 编码');
        }
        console.log('[Codec] Opus encoding supported');

        // 检查 Opus 解码支持
        const decSupported = await AudioDecoder.isConfigSupported({
            codec: 'opus',
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });
        if (!decSupported.supported) {
            throw new Error('浏览器不支持 Opus 解码');
        }
        console.log('[Codec] Opus decoding supported');

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
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1,
            bitrate: CONFIG.opusBitrate
        });

        console.log(`[Encoder] state=${encoder.state}`);

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
                // 解码完成 → 发送 PCM 到 Worklet 播放 (带peerId标识)
                if (workletNode) {
                    const pcmData = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(pcmData, { planeIndex: 0 });
                    console.log(`[Decode:${peerId}] frames=${audioData.numberOfFrames}, sampleRate=${audioData.sampleRate}`);
                    workletNode.port.postMessage({
                        type: 'pcm',
                        peerId: peerId,
                        data: pcmData
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
            sampleRate: CONFIG.sampleRate,
            numberOfChannels: 1
        });

        console.log(`[Decoder:${peerId}] state=${decoder.state}`);
        return decoder;
    }

    // =============================================
    // 加入房间
    // =============================================
    async function joinRoom() {
        if (isInitializing) return;
        isInitializing = true;

        try {
            setStatus('🔄 连接信令服务器...', '#888');
            await connectWebSocket();

            setStatus('🔄 加入多人通话房间...', '#888');

            // 先发送 join 请求，等待服务端返回房间配置
            const userCodecConfig = getSelectedConfig();
            ws.send(JSON.stringify({
                type: 'join',
                roomId: CONFIG.roomId,
                peerId: null,
                codecConfig: userCodecConfig
            }));

            // 等待 joined 消息，获取服务端下发的房间配置
            const roomConfig = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('加入超时')), 10000);
                const origHandler = ws.onmessage;
                ws.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) return;
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'joined') {
                            clearTimeout(timeout);
                            // 恢复原始消息处理器
                            ws.onmessage = origHandler;
                            // 先处理 joined 消息
                            handleSignal(msg);
                            resolve(msg.codecConfig || userCodecConfig);
                        } else if (msg.type === 'error') {
                            clearTimeout(timeout);
                            ws.onmessage = origHandler;
                            reject(new Error(msg.message));
                        }
                    } catch(e) {}
                };
            });

            // 使用服务端下发的房间配置初始化编解码器
            setStatus('🔄 初始化 WebCodecs 编解码器...', '#888');
            CONFIG.sampleRate = roomConfig.sampleRate || CONFIG.sampleRate;
            CONFIG.opusBitrate = roomConfig.opusBitrate || CONFIG.opusBitrate;
            CONFIG.frameDuration = roomConfig.frameDuration || CONFIG.frameDuration;
            CONFIG.jitterBufferFrames = roomConfig.jitterBufferFrames || CONFIG.jitterBufferFrames;
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

            // 锁定配置面板（通话中不可修改）
            enableConfigUI(false);

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
    // 离开房间
    // =============================================
    function leaveRoom() {
        if (ws && isJoined) {
            ws.send(JSON.stringify({ type: 'leave' }));
        }
        cleanup();
        setStatus('⚡ 当前状态：未加入通话房间', '#d4d4d4');
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('joinBtn').textContent = '📞 加入通话';
        document.getElementById('leaveBtn').disabled = true;
        const peersListEl2 = document.getElementById('peersList');
        if (peersListEl2) {
            peersListEl2.innerHTML = '<span style="color:#666; font-size:13px;">暂无其他成员</span>';
        }

        // 隐藏房间配置信息
        if (roomConfigInfoEl) roomConfigInfoEl.style.display = 'none';
        // 恢复配置面板显示（下次加入时可重新选择）
        if (configSectionEl) configSectionEl.style.display = 'block';
        // 隐藏麦克风控制按钮
        if (muteBtnEl) muteBtnEl.style.display = 'none';
        isMuted = false;
    }

    // =============================================
    // 断线重连
    // =============================================
    async function reconnect() {
        if (isInitializing) return;
        try {
            isJoined = false;
            ws = null;
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

        // 恢复配置面板可编辑状态
        enableConfigUI(true);
    }

    // =============================================
    // SFU: 多用户音频包处理
    // =============================================
    function handleAudioPacket(data) {
        // SFU 数据包格式: [发送者ID长度2B][发送者ID字节][采样率2B][序号2B][时间戳4B][Opus数据]
        if (data.length <= 10) return; // 没有音频数据

        // 修复: 使用 data.buffer 构造 DataView 时，必须考虑 byteOffset
        // 但更安全的方式是直接操作 Uint8Array 并手动解析
        let offset = 0;
        const senderIdLength = (data[offset] | (data[offset + 1] << 8));
        offset += 2;
        const senderId = new TextDecoder().decode(data.subarray(offset, offset + senderIdLength));
        offset += senderIdLength;

        // 跳过发送者ID，获取原始音频包
        const audioData = data.subarray(offset);
        if (audioData.length <= 8) return;

        // 修复: 从 audioData 复制到新 Uint8Array 以确保 DataView 对齐
        const alignedBuf = new Uint8Array(8);
        alignedBuf[0] = audioData[0];
        alignedBuf[1] = audioData[1];
        alignedBuf[2] = audioData[2];
        alignedBuf[3] = audioData[3];
        alignedBuf[4] = audioData[4];
        alignedBuf[5] = audioData[5];
        alignedBuf[6] = audioData[6];
        alignedBuf[7] = audioData[7];
        const sampleRate = alignedBuf[0] | (alignedBuf[1] << 8);
        const packetSeq = alignedBuf[2] | (alignedBuf[3] << 8);
        const timestamp = (alignedBuf[4] | (alignedBuf[5] << 8) | (alignedBuf[6] << 16) | (alignedBuf[7] << 24)) >>> 0;
        const opusData = audioData.subarray(8);

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
            duration: CONFIG.frameDuration * 1_000_000,
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
            ? ((stats.bytesSent * 8) / (stats.packetsSent * CONFIG.frameDuration) / 1000).toFixed(1)
            : '0';

        info.innerHTML = `
            <span>🆔 ID: ${myPeerId || '—'}</span><br>
            <span>👥 房间: ${roomPeers.size + (myPeerId ? 1 : 0)} 人</span><br>
            <span>📤 发送: ${stats.packetsSent} 包 | ${bitrateSend}kbps</span><br>
            <span>📥 接收: ${stats.packetsRecv} 包</span><br>
            <span>📊 编码: Opus ${CONFIG.opusBitrate/1000}kbps | ${CONFIG.frameDuration * 1000}ms/帧 | ${CONFIG.sampleRate/1000}kHz</span>
        `;
    }

    // =============================================
    // 编解码配置预设
    // =============================================
    const PRESETS = {
        'low-latency': { sampleRate: 48000, bitrate: 64000, frameDuration: 0.02, jitter: 2 },
        'balanced':    { sampleRate: 48000, bitrate: 32000, frameDuration: 0.04, jitter: 4 },
        'high-quality':{ sampleRate: 48000, bitrate: 64000, frameDuration: 0.04, jitter: 2 },
        'weak-network':{ sampleRate: 16000, bitrate: 16000, frameDuration: 0.06, jitter: 8 }
    };

    function applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;

        configSampleRateEl.value = preset.sampleRate;
        configBitrateEl.value = preset.bitrate;
        configFrameDurationEl.value = preset.frameDuration;
        configJitterEl.value = preset.jitter;

        // 高亮当前预设按钮
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.preset-btn[data-preset="${name}"]`)?.classList.add('active');

        console.log('[Config] Applied preset:', name, preset);
    }

    // =============================================
    // 获取当前UI配置
    // =============================================
    function getSelectedConfig() {
        return {
            sampleRate: parseInt(configSampleRateEl.value),
            opusBitrate: parseInt(configBitrateEl.value),
            frameDuration: parseFloat(configFrameDurationEl.value),
            jitterBufferFrames: parseInt(configJitterEl.value)
        };
    }

    // =============================================
    // 应用服务端下发的房间配置
    // =============================================
    function applyRoomConfig(codecConfig) {
        if (!codecConfig) return;

        // 更新 CONFIG
        if (codecConfig.sampleRate) CONFIG.sampleRate = codecConfig.sampleRate;
        if (codecConfig.opusBitrate) CONFIG.opusBitrate = codecConfig.opusBitrate;
        if (codecConfig.frameDuration) CONFIG.frameDuration = codecConfig.frameDuration;
        if (codecConfig.jitterBufferFrames) CONFIG.jitterBufferFrames = codecConfig.jitterBufferFrames;

        // 显示房间配置信息
        if (roomConfigInfoEl && roomConfigDetailsEl) {
            roomConfigInfoEl.style.display = 'block';
            roomConfigDetailsEl.innerHTML = `
                <div class="room-config-detail">
                    <span class="label">采样率</span>
                    <span class="value">${codecConfig.sampleRate / 1000} kHz</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">比特率</span>
                    <span class="value">${codecConfig.opusBitrate / 1000} kbps</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">帧长</span>
                    <span class="value">${(codecConfig.frameDuration * 1000).toFixed(0)} ms</span>
                </div>
                <div class="room-config-detail">
                    <span class="label">抖动缓冲</span>
                    <span class="value">${codecConfig.jitterBufferFrames} 帧 (${(codecConfig.jitterBufferFrames * codecConfig.frameDuration * 1000).toFixed(0)}ms)</span>
                </div>
            `;
        }

        console.log('[Config] Applied room config:', codecConfig);
    }

    // =============================================
    // 配置面板启用/禁用
    // =============================================
    function enableConfigUI(enabled) {
        const selects = [configSampleRateEl, configBitrateEl, configFrameDurationEl, configJitterEl];
        selects.forEach(el => { if (el) el.disabled = !enabled; });
        document.querySelectorAll('.preset-btn').forEach(b => { b.disabled = !enabled; });
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
        configSectionEl = document.getElementById('configSection');
        roomConfigInfoEl = document.getElementById('roomConfigInfo');
        roomConfigDetailsEl = document.getElementById('roomConfigDetails');
        configSampleRateEl = document.getElementById('configSampleRate');
        configBitrateEl = document.getElementById('configBitrate');
        configFrameDurationEl = document.getElementById('configFrameDuration');
        configJitterEl = document.getElementById('configJitter');

        document.getElementById('joinBtn').onclick = joinRoom;
        document.getElementById('leaveBtn').onclick = leaveRoom;
    muteBtnEl = document.getElementById('muteBtn');
    if (muteBtnEl) {
        muteBtnEl.onclick = toggleMute;
    }

        // 预设模式按钮
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
        });

        // 显示当前房间ID
        if (roomIdDisplayEl) {
            roomIdDisplayEl.textContent = CONFIG.roomId;
        }

        updateRoomStatus();

        console.log(`[VoiceApp] Ready - Room: ${CONFIG.roomId}, WebSocket + WebCodecs`);
        setStatus('⚡ 点击下方按钮加入语音通话', '#d4d4d4');
    }

    return { init, joinRoom, leaveRoom };
})();

window.onload = () => VOICE_APP.init();
