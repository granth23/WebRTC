const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const clients = new Map();
const rooms = new Map();
let clientCounter = 1;

const server = http.createServer((req, res) => {
  const [rawPath] = req.url.split('?');
  const requestPath = rawPath === '/' ? 'index.html' : decodeURIComponent(rawPath.replace(/^\/+/, ''));
  const safePath = path.normalize(requestPath).replace(/^([.]{2}[\/])+/g, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = getContentType(ext);
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }

  if (req.url !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found');
    return;
  }

  const acceptKey = generateAcceptValue(req.headers['sec-websocket-key']);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

  const clientId = clientCounter++;
  const client = {
    id: clientId,
    socket,
    buffer: Buffer.alloc(0),
    roomId: null,
    isHost: false
  };

  clients.set(socket, client);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let result;
    do {
      result = decodeFrame(client.buffer);
      if (result) {
        client.buffer = client.buffer.slice(result.length);
        if (result.opcode === 0x8) {
          socket.end();
          return;
        }

        try {
          const text = result.payload.toString('utf8');
          const message = JSON.parse(text);
          handleMessage(client, message);
        } catch (err) {
          send(client, { type: 'error', message: 'Invalid message format.' });
        }
      }
    } while (result);
  });

  socket.on('close', () => {
    cleanupClient(client);
    clients.delete(socket);
  });

  socket.on('end', () => {
    cleanupClient(client);
    clients.delete(socket);
  });

  socket.on('error', () => {
    cleanupClient(client);
    clients.delete(socket);
  });
});

function handleMessage(client, message) {
  switch (message.type) {
    case 'create':
      return handleCreateRoom(client, message.roomId);
    case 'join':
      return handleJoinRoom(client, message.roomId);
    case 'offer':
    case 'answer':
    case 'candidate':
      return forwardToRoom(client, message);
    case 'leave':
      return cleanupClient(client);
    default:
      send(client, { type: 'error', message: 'Unknown message type.' });
  }
}

function handleCreateRoom(client, requestedRoomId) {
  const roomId = (requestedRoomId || generateRoomCode()).toUpperCase();
  if (rooms.has(roomId)) {
    send(client, { type: 'error', message: 'Room already exists. Choose a different code.' });
    return;
  }

  client.roomId = roomId;
  client.isHost = true;
  rooms.set(roomId, new Set([client]));
  send(client, { type: 'created', roomId });
}

function handleJoinRoom(client, roomIdRaw) {
  if (!roomIdRaw) {
    send(client, { type: 'error', message: 'Room code is required.' });
    return;
  }

  const roomId = roomIdRaw.toUpperCase();
  if (!rooms.has(roomId)) {
    send(client, { type: 'error', message: 'Room not found. Please check the code.' });
    return;
  }

  const participants = rooms.get(roomId);
  if (participants.size >= 2) {
    send(client, { type: 'error', message: 'Room is full.' });
    return;
  }

  client.roomId = roomId;
  client.isHost = false;
  participants.add(client);

  send(client, { type: 'joined', roomId });

  if (participants.size === 2) {
    for (const participant of participants) {
      send(participant, { type: 'ready', initiator: participant.isHost });
    }
  }
}

function forwardToRoom(client, message) {
  if (!client.roomId || !rooms.has(client.roomId)) {
    send(client, { type: 'error', message: 'You are not in a room.' });
    return;
  }

  const participants = rooms.get(client.roomId);
  for (const participant of participants) {
    if (participant !== client) {
      send(participant, message);
    }
  }
}

function cleanupClient(client) {
  const roomId = client.roomId;
  if (!roomId) {
    return;
  }

  const participants = rooms.get(roomId);
  if (!participants) {
    client.roomId = null;
    client.isHost = false;
    return;
  }

  participants.delete(client);
  client.roomId = null;
  client.isHost = false;

  if (participants.size === 0) {
    rooms.delete(roomId);
    return;
  }

  let hasHost = false;
  for (const participant of participants) {
    if (participant.isHost) {
      hasHost = true;
      break;
    }
  }

  if (!hasHost) {
    const [newHost] = participants;
    if (newHost) {
      newHost.isHost = true;
    }
  }

  for (const participant of participants) {
    send(participant, { type: 'peer-left', roomId, isHost: participant.isHost });
  }
}

function send(client, message) {
  try {
    const payload = Buffer.from(JSON.stringify(message));
    const frame = encodeFrame(payload);
    client.socket.write(frame);
  } catch (err) {
    // ignore
  }
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  const opcode = firstByte & 0x0f;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const highBits = buffer.readUInt32BE(offset);
    const lowBits = buffer.readUInt32BE(offset + 4);
    payloadLength = highBits * Math.pow(2, 32) + lowBits;
    offset += 8;
  }

  const isMasked = (secondByte & 0x80) === 0x80;
  let maskingKey;
  if (isMasked) {
    if (buffer.length < offset + 4) return null;
    maskingKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  let payload;
  if (isMasked && maskingKey) {
    payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i += 1) {
      payload[i] = buffer[offset + i] ^ maskingKey[i % 4];
    }
  } else {
    payload = buffer.slice(offset, offset + payloadLength);
  }

  return {
    payload,
    length: offset + payloadLength,
    opcode
  };
}

function encodeFrame(payload) {
  const payloadLength = payload.length;
  let frame;
  if (payloadLength < 126) {
    frame = Buffer.alloc(2 + payloadLength);
    frame[1] = payloadLength;
    payload.copy(frame, 2);
  } else if (payloadLength < 65536) {
    frame = Buffer.alloc(4 + payloadLength);
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + payloadLength);
    frame[1] = 127;
    // Split 64-bit length into two 32-bit parts
    frame.writeUInt32BE(Math.floor(payloadLength / Math.pow(2, 32)), 2);
    frame.writeUInt32BE(payloadLength >>> 0, 6);
    payload.copy(frame, 10);
  }
  frame[0] = 0x81;
  return frame;
}

function generateAcceptValue(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getContentType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
    case '.jsx':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    default:
      return 'text/plain';
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

