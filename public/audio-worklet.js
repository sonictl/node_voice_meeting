// =============================================
// PCM AudioWorklet - SFU 多用户音频处理
// 输入: 麦克风捕获 → 主线程编码
// 输出: 多用户解码PCM混合 → 扬声器播放
// =============================================

class VoiceWorklet extends AudioWorkletProcessor {
    constructor() {
        super();

        // ---- 捕获端参数 ----
        this._sampleRate = sampleRate; // AudioContext 的采样率
        this._frameDuration = 0.04;    // 40ms 帧长
        this._frameSamples = Math.floor(sampleRate * this._frameDuration);
        this._captureBuffer = [];

        // ---- SFU 播放端参数 ----
        this._peerBuffers = new Map(); // peerId -> {buffer: Float32Array, write: number, read: number}

        // ---- 状态 ----
        this._frameSeq = 0;

        // ---- VAD (语音活动检测) 参数 ----
        this._vadThreshold = 0.002;    // 能量阈值，低于此值视为静音
        this._vadHangover = 3;         // 静音挂起帧数（避免频繁切换）
        this._vadHangoverCount = 0;    // 当前挂起计数
        this._isSpeaking = false;      // 当前是否在说话
        this._vadEnabled = true;       // VAD 开关

        // 监听主线程消息
        this.port.onmessage = (event) => this._onMessage(event);

        console.log(`[VoiceWorklet:SFU] Init: ${sampleRate}Hz, ${this._frameSamples}samples/frame`);
    }

    /**
     * VAD: 计算音频帧的能量（均方根 RMS）
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
     * VAD: 判断当前帧是否包含语音
     * @param {Float32Array} samples - PCM 样本
     * @returns {boolean} true=有语音, false=静音
     */
    _isVoiceActive(samples) {
        if (!this._vadEnabled) return true; // VAD 关闭时始终视为有语音

        const energy = this._calculateEnergy(samples);

        if (energy > this._vadThreshold) {
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

        if (data.type === 'pcm' && data.peerId) {
            // SFU: peer-specific PCM data
            const pcm = data.data; // Float32Array
            if (!(pcm instanceof Float32Array)) return;

            // 获取或创建此peer的环形缓冲区
            let peerBuffer = this._peerBuffers.get(data.peerId);
            if (!peerBuffer) {
                peerBuffer = {
                    buffer: new Float32Array(this._frameSamples * 8), // 8帧缓冲
                    write: 0,
                    read: 0
                };
                this._peerBuffers.set(data.peerId, peerBuffer);
                console.log(`[VoiceWorklet] Created buffer for peer: ${data.peerId}`);
            }

            // 写入环形缓冲区
            for (let i = 0; i < pcm.length; i++) {
                peerBuffer.buffer[peerBuffer.write] = pcm[i];
                peerBuffer.write = (peerBuffer.write + 1) % peerBuffer.buffer.length;
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

            // 当积累够一帧时，发送给主线程编码
            if (this._captureBuffer.length >= this._frameSamples) {
                const frame = new Float32Array(this._captureBuffer.slice(0, this._frameSamples));
                this._captureBuffer = this._captureBuffer.slice(this._frameSamples);

                // VAD: 检测当前帧是否包含语音
                const hasVoice = this._isVoiceActive(frame);

                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++,
                    hasVoice: hasVoice,       // VAD 结果
                    energy: this._calculateEnergy(frame) // 能量值（用于说话人指示器）
                });
            }
        }

        // ---- SFU 播放端: 混合所有peer音频 ----
        if (output && output[0]) {
            const outputChannel = output[0];
            const needed = outputChannel.length;

            // 初始化输出为静音
            outputChannel.fill(0);

            // 从每个peer缓冲区读取并混合
            let activePeers = 0;
            for (const [peerId, peerBuffer] of this._peerBuffers) {
                const available = this._getPeerBufferedSamples(peerId);
                if (available >= needed) {
                    const peerAudio = this._readFromPeerBuffer(peerId, needed);
                    // 混合音频 (简单相加，之后可以添加音量控制)
                    for (let i = 0; i < needed; i++) {
                        outputChannel[i] += peerAudio[i];
                    }
                    activePeers++;
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
