// =============================================
// PCM AudioWorklet - SFU 多用户音频处理
// 输入: 麦克风捕获(48kHz) → 主线程降采样→编码
// 输出: 多用户解码PCM(升采样48kHz后)混合 → 扬声器播放
// v1.0 - 2026-05-03
// =============================================

class VoiceWorklet extends AudioWorkletProcessor {
    constructor() {
        super();

        // ---- 捕获端参数（默认值，等待主线程 config 消息覆盖） ----
        this._sampleRate = sampleRate; // AudioContext 的采样率 (48kHz)
        this._frameDuration = 0.06;    // 默认60ms，由主线程 config 消息更新
        this._frameSamples = Math.floor(sampleRate * this._frameDuration); // 默认2880 samples @48kHz
        this._captureBuffer = [];

        // ---- SFU 播放端参数 ----
        this._peerBuffers = new Map(); // peerId -> {buffer: Float32Array, write: number, read: number, isReady: boolean}
        this._jitterBufferFrames = 8;  // 默认8帧，由主线程 config 消息更新
        this._preBufferFrames = 2;     // 预缓冲帧数：等待2帧数据后再开始播放

        // ---- 状态 ----
        this._frameSeq = 0;

        // ---- RMS 能量检测参数 ----
        this._rmsThreshold = 0.008;    // 能量阈值，降低阈值避免误判静音
        this._vadHangover = 3;         // 静音挂起帧数（避免频繁切换）
        this._vadHangoverCount = 0;    // 当前挂起计数
        this._isSpeaking = false;      // 当前是否在说话

        // 监听主线程消息
        this.port.onmessage = (event) => this._onMessage(event);

        console.log(`[VoiceWorklet:SFU] Init: ${sampleRate}Hz, ${this._frameSamples}samples/frame (default 60ms)`);
    }

    /**
     * RMS: 计算音频帧的均方根能量
     * @param {Float32Array} samples - PCM 样本
     * @returns {number} 能量值
     */
    _calculateEnergy(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / samples.length);
    }

    /**
     * RMS 能量检测：判断当前帧是否包含语音
     * @param {Float32Array} samples - PCM 样本
     * @returns {boolean} true=有语音, false=静音
     */
    _isVoiceActive(samples) {
        const energy = this._calculateEnergy(samples);

        if (energy > this._rmsThreshold) {
            // 检测到语音
            this._vadHangoverCount = this._vadHangover;
            this._isSpeaking = true;
            return true;
        } else {
            // 静音：使用挂起计数器避免频繁切换
            if (this._vadHangoverCount > 0) {
                this._vadHangoverCount--;
                return true; // 挂起期间仍视为有语音
            }
            this._isSpeaking = false;
            return false;
        }
    }

    /**
     * 主线程发来的解码后 PCM 数据 (SFU: 带peerId)
     */
    _onMessage(event) {
        const data = event.data;

        if (data.type === 'config') {
            // 从主线程接收编解码参数配置
            if (data.frameDuration) {
                this._frameDuration = data.frameDuration;
                this._frameSamples = Math.floor(this._sampleRate * this._frameDuration);
                console.log(`[VoiceWorklet] Config: frameDuration=${data.frameDuration}s, frameSamples=${this._frameSamples}`);
            }
            if (data.jitterBufferFrames) {
                this._jitterBufferFrames = data.jitterBufferFrames;
                console.log(`[VoiceWorklet] Config: jitterBufferFrames=${data.jitterBufferFrames}`);
            }
            return;
        }

        if (data.type === 'pcm' && data.peerId) {
            // SFU: peer-specific PCM data (已升采样到48kHz)
            const pcm = data.data; // Float32Array
            if (!(pcm instanceof Float32Array)) return;

            // 获取或创建此peer的环形缓冲区（8帧抖动缓冲）
            let peerBuffer = this._peerBuffers.get(data.peerId);
            if (!peerBuffer) {
                peerBuffer = {
                    buffer: new Float32Array(this._frameSamples * 8), // 8帧缓冲 (~480ms)
                    write: 0,
                    read: 0,
                    isReady: false  // 标记是否已预缓冲完成
                };
                this._peerBuffers.set(data.peerId, peerBuffer);
                console.log(`[VoiceWorklet] Created buffer for peer: ${data.peerId}`);
            }

            // 写入环形缓冲区
            for (let i = 0; i < pcm.length; i++) {
                peerBuffer.buffer[peerBuffer.write] = pcm[i];
                peerBuffer.write = (peerBuffer.write + 1) % peerBuffer.buffer.length;
            }

            // 检查是否已预缓冲足够数据（2帧 = ~120ms）
            if (!peerBuffer.isReady) {
                const buffered = this._getPeerBufferedSamples(data.peerId);
                const preBufferSamples = this._frameSamples * this._preBufferFrames;
                if (buffered >= preBufferSamples) {
                    peerBuffer.isReady = true;
                    console.log(`[VoiceWorklet] Peer ${data.peerId} ready: buffered ${buffered} samples (${(buffered/this._sampleRate*1000).toFixed(0)}ms)`);
                }
            }
        }

        if (data.type === 'reset') {
            // 重置所有peer缓冲区
            this._peerBuffers.clear();
            this._captureBuffer = [];
        }

        if (data.type === 'flush') {
            // 输出剩余捕获数据
            if (this._captureBuffer.length > 0) {
                const frame = new Float32Array(this._captureBuffer);
                this._captureBuffer = [];
                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++
                });
            }
        }
    }

    /**
     * 获取指定peer缓冲区中可用样本数
     */
    _getPeerBufferedSamples(peerId) {
        const peerBuffer = this._peerBuffers.get(peerId);
        if (!peerBuffer) return 0;

        let samples = peerBuffer.write - peerBuffer.read;
        if (samples < 0) samples += peerBuffer.buffer.length;
        return samples;
    }

    /**
     * 从指定peer缓冲区读取 count 个样本
     */
    _readFromPeerBuffer(peerId, count) {
        const peerBuffer = this._peerBuffers.get(peerId);
        if (!peerBuffer) return new Float32Array(count).fill(0);

        const output = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            output[i] = peerBuffer.buffer[peerBuffer.read];
            peerBuffer.read = (peerBuffer.read + 1) % peerBuffer.buffer.length;
        }
        return output;
    }

    /**
     * AudioWorklet 主处理循环
     * 每次调用处理 128 个样本（约 2.67ms @48kHz）
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // ---- 捕获端: 累积麦克风输入 ----
        if (input && input[0]) {
            const channelData = input[0];
            this._captureBuffer.push(...channelData);

            // 当积累够一帧时（60ms = 2880 samples @48kHz），发送给主线程编码
            if (this._captureBuffer.length >= this._frameSamples) {
                const frame = new Float32Array(this._captureBuffer.slice(0, this._frameSamples));
                this._captureBuffer = this._captureBuffer.slice(this._frameSamples);

                // RMS 能量检测：判断当前帧是否包含语音
                const hasVoice = this._isVoiceActive(frame);

                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++,
                    hasVoice: hasVoice,       // RMS 检测结果
                    energy: this._calculateEnergy(frame) // 能量值（用于说话人指示器）
                });
            }
        }

        // ---- SFU 播放端: 混合所有peer音频（输出到所有声道，避免单声道问题） ----
        if (output && output[0]) {
            const needed = output[0].length;

            // 先混合到临时缓冲区
            const mixed = new Float32Array(needed);
            mixed.fill(0);

            // 从每个peer缓冲区读取并混合
            let activePeers = 0;
            for (const [peerId, peerBuffer] of this._peerBuffers) {
                // 只有预缓冲完成的peer才参与播放
                if (!peerBuffer.isReady) continue;

                const available = this._getPeerBufferedSamples(peerId);
                if (available >= needed) {
                    const peerAudio = this._readFromPeerBuffer(peerId, needed);
                    // 混合音频 (简单相加)
                    for (let i = 0; i < needed; i++) {
                        mixed[i] += peerAudio[i];
                    }
                    activePeers++;
                } else {
                    // 缓冲区欠载：重置为未就绪状态，等待重新预缓冲
                    peerBuffer.isReady = false;
                    console.log(`[VoiceWorklet] Peer ${peerId} underrun, reset to buffering`);
                }
            }

            // 音量均衡：多人同时说话时归一化，避免爆音
            if (activePeers > 1) {
                const gain = 1 / activePeers;
                for (let i = 0; i < needed; i++) {
                    mixed[i] *= gain;
                }
            }

            // 将混合后的音频复制到所有输出声道（解决单声道问题）
            for (let ch = 0; ch < output.length; ch++) {
                const outChannel = output[ch];
                for (let i = 0; i < needed; i++) {
                    outChannel[i] = mixed[i];
                }
            }

            // 如果没有活跃的peer，通知欠载
            if (activePeers === 0) {
                this.port.postMessage({ type: 'underrun', available: 0, needed });
            }
        }

        return true; // 保持处理器存活
    }
}

registerProcessor('voice-worklet', VoiceWorklet);
