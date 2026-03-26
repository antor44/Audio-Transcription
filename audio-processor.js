// AudioWorklet processor for audio capture.
// Replaces the deprecated ScriptProcessorNode (createScriptProcessor).
// This file must be registered via AudioContext.audioWorklet.addModule().
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer size equivalent to the old ScriptProcessorNode bufferSize of 4096.
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize);
    this._filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];

    let offset = 0;
    while (offset < channel.length) {
      const space = this._bufferSize - this._filled;
      const toCopy = Math.min(space, channel.length - offset);
      this._buffer.set(channel.subarray(offset, offset + toCopy), this._filled);
      this._filled += toCopy;
      offset += toCopy;

      if (this._filled >= this._bufferSize) {
        // Transfer a copy of the filled buffer to the main thread.
        const chunk = this._buffer.slice(0);
        this.port.postMessage(chunk, [chunk.buffer]);
        this._filled = 0;
      }
    }

    // Keep the processor alive as long as the node is connected.
    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
