import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD = 64 * 1024;

export function encodeWsFrame(opcode, payloadBuffer) {
  const length = payloadBuffer.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

export function upgradeWebSocket(request, socket, head = Buffer.alloc(0), { maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
  const upgradeHeader = request.headers.upgrade?.toLowerCase() ?? '';
  const key = request.headers['sec-websocket-key']?.trim() ?? '';
  const version = request.headers['sec-websocket-version']?.trim() ?? '';

  if (upgradeHeader !== 'websocket' || !key || (version && version !== '13')) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }

  const acceptKey = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.setNoDelay?.(true);
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n'),
  );

  let closed = false;
  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragments = [];
  let fragmentBytes = 0;

  const messageListeners = new Set();
  const closeListeners = new Set();

  function emitClose() {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    fragments = [];
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // Ignore close listener errors.
      }
    }
  }

  function writeRaw(frame) {
    if (closed || socket.destroyed || !socket.writable) return false;
    try {
      return socket.write(frame);
    } catch {
      return false;
    }
  }

  function closeSocket(code = 1000, reason = '') {
    if (closed) return;
    const reasonBytes = reason ? Buffer.from(reason, 'utf8').subarray(0, 120) : Buffer.alloc(0);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    writeRaw(encodeWsFrame(0x08, payload));
    socket.end();
    setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 250).unref?.();
    emitClose();
  }

  function processBuffer() {
    while (!closed && buffer.length >= 2) {
      const byte0 = buffer[0];
      const byte1 = buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const rsv = byte0 & 0x70;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (rsv !== 0 || !masked) {
        closeSocket(1002, 'Protocol error');
        return;
      }

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(maxPayload)) {
          closeSocket(1009, 'Message too big');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > maxPayload || fragmentBytes + payloadLen > maxPayload) {
        closeSocket(1009, 'Message too big');
        return;
      }

      const totalFrameLen = offset + 4 + payloadLen;
      if (buffer.length < totalFrameLen) return;

      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[offset + 4 + i] ^ mask[i & 3];
      }
      buffer = buffer.subarray(totalFrameLen);

      if (opcode === 0x08) {
        closeSocket(1000);
        return;
      }
      if (opcode === 0x09) {
        if (payloadLen <= 125) writeRaw(encodeWsFrame(0x0a, payload));
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x00) {
        if (fragmentOpcode === null) {
          closeSocket(1002, 'Unexpected continuation');
          return;
        }
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fin) {
          const full = Buffer.concat(fragments, fragmentBytes);
          const doneOpcode = fragmentOpcode;
          fragmentOpcode = null;
          fragments = [];
          fragmentBytes = 0;
          dispatchMessage(doneOpcode, full);
        }
        continue;
      }

      if (opcode === 0x01 || opcode === 0x02) {
        if (!fin) {
          fragmentOpcode = opcode;
          fragments = [payload];
          fragmentBytes = payload.length;
          continue;
        }
        dispatchMessage(opcode, payload);
        continue;
      }

      closeSocket(1003, 'Unsupported opcode');
      return;
    }
  }

  function dispatchMessage(opcode, payload) {
    const isBinary = opcode === 0x02;
    const data = isBinary ? payload : payload.toString('utf8');
    for (const listener of messageListeners) {
      try {
        listener(data, isBinary);
      } catch {
        // Keep connection alive on handler error unless explicitly closed.
      }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    processBuffer();
  });
  socket.on('close', emitClose);
  socket.on('end', emitClose);
  socket.on('error', emitClose);

  if (buffer.length > 0) {
    queueMicrotask(processBuffer);
  }

  return {
    get closed() {
      return closed;
    },
    get bufferedAmount() {
      return socket.writableLength ?? 0;
    },
    sendText(text) {
      return writeRaw(encodeWsFrame(0x01, Buffer.from(text, 'utf8')));
    },
    sendJson(value) {
      return writeRaw(encodeWsFrame(0x01, Buffer.from(JSON.stringify(value), 'utf8')));
    },
    sendBinary(bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return writeRaw(encodeWsFrame(0x02, buf));
    },
    close: closeSocket,
    onMessage(fn) {
      messageListeners.add(fn);
      return () => messageListeners.delete(fn);
    },
    onClose(fn) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
  };
}
