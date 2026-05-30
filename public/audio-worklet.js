// =============================================
// PCM AudioWorklet - SFU 多用户音频处理
// 输入: 麦克风捕获(48kHz) → 主线程降采样→编码
// 输出: 多用户解码PCM(升采样48kHz后)混合 → 扬声器播放
// v1.3 - 自适应抖动缓冲
//   1. 环形缓冲区从8帧→20帧 (1200ms)
//   2. 添加预填机制：填满50%后才开始播放
//   3. 添加PLC（丢包隐藏）：欠载时重复最后一帧
//   4. 修复缓冲区大小计算时机
//   5. 自适应抖动缓冲：根据欠载率动态调整缓冲区大小
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
        this._peerBuffers = new Map(); // peerId -> {buffer: Float32Array, write: number, read: number, isReady: boolean, lastFrame: Float32Array, plcCount: number, totalPlcFrames: number, totalReadFrames: number}
        this._jitterBufferFrames = 20;  // 初始20帧 (~1200ms)
        this._minJitterFrames = 8;      // 最小8帧 (~480ms)
        this._maxJitterFrames = 30;     // 最大30帧 (~1800ms)
        this._preBufferRatio = 0.5;     // 预缓冲比例：填满50%后才开始播放
        this._maxPlcFrames = 5;         // 最大连续PLC帧数

        // ---- 自适应抖动缓冲参数 ----
        this._adaptiveInterval = 0;     // 自适应评估计数器（帧数）
        this._adaptiveIntervalFrames = 100; // 每100帧评估一次（约6秒 @60ms帧长）
        this._underrunThreshold = 0.05; // 欠载率>5%时增大缓冲区
        this._safeThreshold = 0.01;     // 欠载率<1%时减小缓冲区
        this._currentLossRate = 0;      // 当前评估周期的欠载率

        // ---- 状态 ----
        this._frameSeq = 0;

        // ---- RMS 能量检测参数 ----
        this._rmsThreshold = 0.008;
        this._vadHangover = 3;
        this._vadHangoverCount = 0;
        this._isSpeaking = false;

        // 监听主线程消息
        this.port.onmessage = (event) => this._onMessage(event);

        console.log(`[VoiceWorklet:SFU] Init: ${sampleRate}Hz, ${this._frameSamples}samples/frame, jitter=${this._jitterBufferFrames}frames (adaptive ${this._minJitterFrames}-${this._maxJitterFrames})`);
    }

    /**
     * RMS: 计算音频帧的均方根能量
     */
    _calculateEnergy(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / samples.length);
    }

    /**
     * RMS 能量检测
     */
    _isVoiceActive(samples) {
        const energy = this._calculateEnergy(samples);
        if (energy > this._rmsThreshold) {
            this._vadHangoverCount = this._vadHangover;
            this._isSpeaking = true;
            return true;
        } else {
            if (this._vadHangoverCount > 0) {
                this._vadHangoverCount--;
                return true;
            }
            this._isSpeaking = false;
            return false;
        }
    }

    /**
     * 主线程发来的解码后 PCM 数据
     */
    _onMessage(event) {
        const data = event.data;

        if (data.type === 'config') {
            if (data.frameDuration) {
                this._frameDuration = data.frameDuration;
                this._frameSamples = Math.floor(this._sampleRate * this._frameDuration);
                console.log(`[VoiceWorklet] Config: frameDuration=${data.frameDuration}s, frameSamples=${this._frameSamples}`);
            }
            if (data.jitterBufferFrames) {
                this._jitterBufferFrames = data.jitterBufferFrames;
                console.log(`[VoiceWorklet] Config: jitterBufferFrames=${data.jitterBufferFrames}`);
            }
            if (data.minJitterFrames) {
                this._minJitterFrames = data.minJitterFrames;
            }
            if (data.maxJitterFrames) {
                this._maxJitterFrames = data.maxJitterFrames;
            }
            return;
        }

        if (data.type === 'pcm' && data.peerId) {
            const pcm = data.data;
            if (!(pcm instanceof Float32Array)) return;

            let peerBuffer = this._peerBuffers.get(data.peerId);
            if (!peerBuffer) {
                const bufferSize = this._frameSamples * this._jitterBufferFrames;
                peerBuffer = {
                    buffer: new Float32Array(bufferSize),
                    write: 0,
                    read: 0,
                    isReady: false,
                    lastFrame: null,
                    plcCount: 0,
                    totalPlcFrames: 0,    // 累计PLC帧数（用于自适应评估）
                    totalReadFrames: 0     // 累计读取帧数（用于自适应评估）
                };
                this._peerBuffers.set(data.peerId, peerBuffer);
                console.log(`[VoiceWorklet] Created buffer for peer: ${data.peerId}, size=${bufferSize}samples (${this._jitterBufferFrames}frames)`);
            }

            // 写入环形缓冲区
            for (let i = 0; i < pcm.length; i++) {
                peerBuffer.buffer[peerBuffer.write] = pcm[i];
                peerBuffer.write = (peerBuffer.write + 1) % peerBuffer.buffer.length;
            }

            peerBuffer.lastFrame = new Float32Array(pcm);
            peerBuffer.plcCount = 0;

            // 检查预缓冲
            if (!peerBuffer.isReady) {
                const buffered = this._getPeerBufferedSamples(data.peerId);
                const preBufferSamples = Math.floor(this._frameSamples * this._jitterBufferFrames * this._preBufferRatio);
                if (buffered >= preBufferSamples) {
                    peerBuffer.isReady = true;
                    console.log(`[VoiceWorklet] Peer ${data.peerId} ready: buffered ${buffered} samples (${(buffered/this._sampleRate*1000).toFixed(0)}ms)`);
                }
            }
        }

        if (data.type === 'reset') {
            this._peerBuffers.clear();
            this._captureBuffer = [];
        }

        if (data.type === 'flush') {
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
     * 如果缓冲区欠载，使用PLC（重复最后一帧）
     */
    _readFromPeerBuffer(peerId, count) {
        const peerBuffer = this._peerBuffers.get(peerId);
        if (!peerBuffer) return new Float32Array(count).fill(0);

        const available = this._getPeerBufferedSamples(peerId);
        const output = new Float32Array(count);

        if (available >= count) {
            // 正常读取
            for (let i = 0; i < count; i++) {
                output[i] = peerBuffer.buffer[peerBuffer.read];
                peerBuffer.read = (peerBuffer.read + 1) % peerBuffer.buffer.length;
            }
            peerBuffer.lastFrame = new Float32Array(output);
            peerBuffer.plcCount = 0;
            peerBuffer.totalReadFrames++; // 统计正常读取帧数
        } else {
            // ---- PLC（丢包隐藏） ----
            if (peerBuffer.lastFrame && peerBuffer.plcCount < this._maxPlcFrames) {
                const decayFactor = Math.max(0.3, 1.0 - peerBuffer.plcCount * 0.15);
                for (let i = 0; i < count; i++) {
                    output[i] = peerBuffer.lastFrame[i % peerBuffer.lastFrame.length] * decayFactor;
                }
                peerBuffer.plcCount++;
                peerBuffer.totalPlcFrames++; // 统计PLC帧数
            } else {
                output.fill(0);
                if (peerBuffer.plcCount >= this._maxPlcFrames) {
                    peerBuffer.isReady = false;
                    peerBuffer.plcCount = 0;
                    console.log(`[VoiceWorklet] Peer ${peerId} long underrun, reset to buffering`);
                }
            }

            if (available > 0) {
                for (let i = 0; i < available; i++) {
                    output[i] = peerBuffer.buffer[peerBuffer.read];
                    peerBuffer.read = (peerBuffer.read + 1) % peerBuffer.buffer.length;
                }
            }
        }

        return output;
    }

    /**
     * 自适应抖动缓冲评估
     * 每 _adaptiveIntervalFrames 帧评估一次，根据欠载率调整缓冲区大小
     */
    _evaluateAdaptiveJitter() {
        let totalPlc = 0;
        let totalRead = 0;
        let activePeerCount = 0;

        for (const [peerId, peerBuffer] of this._peerBuffers) {
            if (!peerBuffer.isReady) continue;
            totalPlc += peerBuffer.totalPlcFrames;
            totalRead += peerBuffer.totalReadFrames;
            activePeerCount++;

            // 重置统计
            peerBuffer.totalPlcFrames = 0;
            peerBuffer.totalReadFrames = 0;
        }

        if (activePeerCount === 0 || totalRead === 0) return;

        // 计算欠载率
        const lossRate = totalPlc / (totalRead + totalPlc);
        this._currentLossRate = lossRate;

        let oldFrames = this._jitterBufferFrames;

        if (lossRate > this._underrunThreshold) {
            // 欠载率>5%：网络差，增大缓冲区
            this._jitterBufferFrames = Math.min(
                this._maxJitterFrames,
                this._jitterBufferFrames + 2
            );
            console.log(`[Adaptive] Loss=${(lossRate*100).toFixed(1)}% > 5%, increase jitter: ${oldFrames}→${this._jitterBufferFrames}frames`);
        } else if (lossRate < this._safeThreshold && this._jitterBufferFrames > this._minJitterFrames) {
            // 欠载率<1%：网络好，减小缓冲区降低延迟
            this._jitterBufferFrames = Math.max(
                this._minJitterFrames,
                this._jitterBufferFrames - 1
            );
            console.log(`[Adaptive] Loss=${(lossRate*100).toFixed(1)}% < 1%, decrease jitter: ${oldFrames}→${this._jitterBufferFrames}frames`);
        }

        // 如果缓冲区大小变了，通知主线程更新UI
        if (oldFrames !== this._jitterBufferFrames) {
            this.port.postMessage({
                type: 'jitter_adjusted',
                oldFrames: oldFrames,
                newFrames: this._jitterBufferFrames,
                lossRate: lossRate
            });
        }
    }

    /**
     * AudioWorklet 主处理循环
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // ---- 捕获端 ----
        if (input && input[0]) {
            const channelData = input[0];
            this._captureBuffer.push(...channelData);

            if (this._captureBuffer.length >= this._frameSamples) {
                const frame = new Float32Array(this._captureBuffer.slice(0, this._frameSamples));
                this._captureBuffer = this._captureBuffer.slice(this._frameSamples);

                const hasVoice = this._isVoiceActive(frame);

                this.port.postMessage({
                    type: 'pcm',
                    data: frame,
                    sampleRate: this._sampleRate,
                    seq: this._frameSeq++,
                    hasVoice: hasVoice,
                    energy: this._calculateEnergy(frame)
                });
            }
        }

        // ---- SFU 播放端 ----
        if (output && output[0]) {
            const needed = output[0].length;

            const mixed = new Float32Array(needed);
            mixed.fill(0);

            let activePeers = 0;
            for (const [peerId, peerBuffer] of this._peerBuffers) {
                if (!peerBuffer.isReady) continue;

                const peerAudio = this._readFromPeerBuffer(peerId, needed);
                for (let i = 0; i < needed; i++) {
                    mixed[i] += peerAudio[i];
                }
                activePeers++;
            }

            if (activePeers > 1) {
                const gain = 1 / activePeers;
                for (let i = 0; i < needed; i++) {
                    mixed[i] *= gain;
                }
            }

            for (let ch = 0; ch < output.length; ch++) {
                const outChannel = output[ch];
                for (let i = 0; i < needed; i++) {
                    outChannel[i] = mixed[i];
                }
            }

            if (activePeers === 0) {
                this.port.postMessage({ type: 'underrun', available: 0, needed });
            }

            // ---- 自适应抖动缓冲评估 ----
            this._adaptiveInterval++;
            if (this._adaptiveInterval >= this._adaptiveIntervalFrames) {
                this._adaptiveInterval = 0;
                this._evaluateAdaptiveJitter();
            }
        }

        return true;
    }
}

registerProcessor('voice-worklet', VoiceWorklet);
