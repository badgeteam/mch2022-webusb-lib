export function concatBuffers(...buffers: ArrayBuffer[]) {
    let total_length = 0;
    for (let i = 0; i < buffers.length; i++) {
        total_length += buffers[i].byteLength;
    }
    var tmp = new Uint8Array(total_length);
    let offset = 0;
    for (let i = 0; i < buffers.length; i++) {
        if (buffers[i].byteLength === 0) continue;
        tmp.set(new Uint8Array(buffers[i]), offset);
        offset += buffers[i].byteLength;
    }
    return tmp.buffer;
}
