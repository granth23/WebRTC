const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CLIENT_BUILD_DIR = path.join(__dirname, 'client', 'dist');
const CLIENT_INDEX_FILE = path.join(CLIENT_BUILD_DIR, 'index.html');

const clients = new Map();
const rooms = new Map();
const waitingUsers = new Map();
const employees = new Set();
const roomMetadata = new Map();
let clientCounter = 1;
const MAX_INLINE_DOCUMENT_LENGTH = 4_500_000;

const server = http.createServer((req, res) => {
  if (!fs.existsSync(CLIENT_INDEX_FILE)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMissingBuildPage());
    return;
  }

  const [rawPath] = req.url.split('?');
  const trimmed = rawPath.replace(/^\/+/, '');
  const requestPath = trimmed.length === 0 ? 'index.html' : decodeURIComponent(trimmed);
  const safePath = path.normalize(requestPath).replace(/^([.]{2}[\/])+/g, '');
  const filePath = path.join(CLIENT_BUILD_DIR, safePath);

  if (!filePath.startsWith(CLIENT_BUILD_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        if (!path.extname(safePath)) {
          fs.readFile(CLIENT_INDEX_FILE, (indexErr, indexData) => {
            if (indexErr) {
              res.writeHead(500);
              res.end('Failed to load client.');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexData);
          });
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
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
    isHost: false,
    role: null,
    displayName: ''
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
    case 'register-user':
      return handleRegisterUser(client, message);
    case 'employee-ready':
      return handleEmployeeReady(client);
    case 'list-users':
      return sendUserList(client);
    case 'create':
      return handleCreateRoom(client, message.roomId);
    case 'join':
      return handleJoinRoom(client, message.roomId);
    case 'verify-code':
      return handleVerifyCode(client, message.code);
    case 'offer':
    case 'answer':
    case 'candidate':
      return forwardToRoom(client, message);
    case 'leave':
      return cleanupClient(client, { preserveRole: client.role === 'employee' });
    default:
      send(client, { type: 'error', message: 'Unknown message type.' });
  }
}

function handleRegisterUser(client, payload = {}) {
  if (client.roomId) {
    send(client, { type: 'error', message: 'You already have an active session.' });
    return;
  }

  const name = sanitizeDisplayName(payload.name);
  if (!name) {
    send(client, { type: 'error', message: 'A valid display name is required.' });
    return;
  }

  let roomId = generateRoomCode();
  while (rooms.has(roomId)) {
    roomId = generateRoomCode();
  }

  client.role = 'user';
  client.displayName = name;
  client.roomId = roomId;
  client.isHost = true;

  rooms.set(roomId, new Set([client]));
  const details = sanitizeSessionDetails(payload.details);
  const verificationCode = generateVerificationCode();

  roomMetadata.set(roomId, { details, verificationCode });
  waitingUsers.set(roomId, { name, createdAt: Date.now() });

  send(client, { type: 'registered', roomId, name, verificationCode });
  broadcastUserList();
}

function handleEmployeeReady(client) {
  client.role = 'employee';
  client.displayName = '';
  employees.add(client);
  sendUserList(client);
}

function sendUserList(target) {
  if (target.role && target.role !== 'employee') {
    send(target, { type: 'error', message: 'User list is only available to employees.' });
    return;
  }

  const payload = createWaitingListPayload();
  send(target, payload);
}

function broadcastUserList() {
  if (employees.size === 0) {
    return;
  }
  const payload = createWaitingListPayload();
  for (const employee of employees) {
    send(employee, payload);
  }
}

function createWaitingListPayload() {
  const users = [];
  for (const [roomId, entry] of waitingUsers) {
    users.push({ roomId, name: entry.name });
  }
  return { type: 'user-list', users };
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

  if (client.roomId) {
    send(client, { type: 'error', message: 'You are already in a session.' });
    return;
  }

  const participants = rooms.get(roomId);
  if (participants.size >= 2) {
    send(client, { type: 'error', message: 'Room is full.' });
    return;
  }

  if (client.role && client.role !== 'employee') {
    send(client, { type: 'error', message: 'Only employees can join existing sessions.' });
    return;
  }

  client.role = 'employee';
  employees.add(client);
  client.roomId = roomId;
  client.isHost = false;
  participants.add(client);

  const wasQueued = waitingUsers.delete(roomId);
  if (wasQueued) {
    broadcastUserList();
  }

  let hostName = null;
  for (const participant of participants) {
    if (participant !== client && participant.isHost && participant.displayName) {
      hostName = participant.displayName;
      break;
    }
  }

  const joinMessage = { type: 'joined', roomId };
  if (hostName) {
    joinMessage.hostName = hostName;
  }
  const metadata = roomMetadata.get(roomId);
  if (metadata && metadata.details) {
    joinMessage.details = metadata.details;
  }
  send(client, joinMessage);

  if (participants.size === 2) {
    for (const participant of participants) {
      send(participant, { type: 'ready', initiator: participant.isHost });
    }
  }
}

function handleVerifyCode(client, providedCode) {
  if (client.role !== 'employee' || !client.roomId) {
    send(client, { type: 'error', message: 'You are not in an active session.' });
    return;
  }

  const metadata = roomMetadata.get(client.roomId);
  if (!metadata) {
    send(client, { type: 'verification-error', message: 'Session metadata unavailable. Please retry.' });
    return;
  }

  const expected = metadata.verificationCode;
  const submitted = sanitizeVerificationCode(providedCode);

  if (!submitted) {
    send(client, { type: 'verification-error', message: 'Enter the 4-digit code shared with the customer.' });
    return;
  }

  if (submitted !== expected) {
    send(client, { type: 'verification-error', message: 'The code does not match. Please verify with the customer.' });
    return;
  }

  const participants = rooms.get(client.roomId);
  if (participants) {
    for (const participant of participants) {
      send(participant, { type: 'verification-complete', verificationCode: expected });
    }
  }

  roomMetadata.delete(client.roomId);
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

function cleanupClient(client, options = {}) {
  const roomId = client.roomId;
  const preserveRole = options.preserveRole === true && client.role === 'employee';

  if (client.role === 'employee' && !preserveRole) {
    employees.delete(client);
  }

  if (roomId) {
    waitingUsers.delete(roomId);
  }

  const participants = roomId ? rooms.get(roomId) : null;

  if (!participants) {
    if (roomId) {
      rooms.delete(roomId);
      roomMetadata.delete(roomId);
      broadcastUserList();
    }
    client.roomId = null;
    client.isHost = false;
    if (!preserveRole) {
      client.role = null;
    }
    client.displayName = '';
    return;
  }

  participants.delete(client);
  client.roomId = null;
  client.isHost = false;
  client.displayName = '';
  if (!preserveRole) {
    client.role = null;
  }

  if (participants.size === 0) {
    rooms.delete(roomId);
    waitingUsers.delete(roomId);
    roomMetadata.delete(roomId);
    broadcastUserList();
    return;
  }

  let host = null;
  for (const participant of participants) {
    if (participant.isHost) {
      host = participant;
      break;
    }
  }

  if (!host) {
    const [firstParticipant] = participants;
    if (firstParticipant) {
      firstParticipant.isHost = true;
      host = firstParticipant;
    }
  }

  for (const participant of participants) {
    send(participant, { type: 'peer-left', roomId, isHost: participant.isHost });
  }

  if (host && host.role === 'user') {
    waitingUsers.set(roomId, { name: host.displayName || roomId, createdAt: Date.now() });
  } else {
    waitingUsers.delete(roomId);
    roomMetadata.delete(roomId);
  }

  broadcastUserList();
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

function sanitizeDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.slice(0, 48);
}

function sanitizeSessionDetails(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const details = {};
  if (typeof value.panNumber === 'string') {
    const pan = value.panNumber.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (pan) {
      details.panNumber = pan;
    }
  }
  if (typeof value.panName === 'string') {
    const name = value.panName.replace(/\s+/g, ' ').trim().slice(0, 64);
    if (name) {
      details.panName = name;
    }
  }
  if (typeof value.dob === 'string') {
    const dob = value.dob.trim().slice(0, 32);
    if (dob) {
      details.dob = dob;
    }
  }
  if (typeof value.address === 'string') {
    const address = value.address
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 320);
    if (address) {
      details.address = address;
    }
  }
  if (typeof value.panFrontName === 'string') {
    const documentName = value.panFrontName.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (documentName) {
      details.panFrontName = documentName;
    }
  }
  if (typeof value.panFrontImage === 'string') {
    const imageData = value.panFrontImage.trim();
    if (
      imageData &&
      imageData.length <= MAX_INLINE_DOCUMENT_LENGTH &&
      /^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,/i.test(imageData)
    ) {
      details.panFrontImage = imageData;
    }
  }

  return Object.keys(details).length > 0 ? details : null;
}

function generateVerificationCode() {
  const code = Math.floor(1000 + Math.random() * 9000);
  return String(code);
}

function sanitizeVerificationCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  const digits = String(value).replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? digits : '';
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
    case '.mjs':
    case '.jsx':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.map':
      return 'application/json';
    case '.webm':
      return 'video/webm';
    default:
      return 'text/plain';
  }
}

function renderMissingBuildPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebRTC signaling server</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 3rem; background: #0f172a; color: #e2e8f0; }
      main { max-width: 640px; margin: 0 auto; background: rgba(15,23,42,.82); padding: 2rem 2.5rem; border-radius: 16px; border: 1px solid rgba(148,163,184,.35); box-shadow: 0 20px 50px rgba(2,6,23,.6); }
      h1 { margin-top: 0; font-size: 1.8rem; }
      code { background: rgba(15,23,42,.92); padding: 0.2rem 0.45rem; border-radius: 6px; }
      ol { line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Signaling server is running</h1>
      <p>This process only handles WebSocket signaling for active sessions. Launch the dedicated interfaces in separate terminals:</p>
      <ol>
        <li>Install dependencies: <code>npm run user:install</code> and <code>npm run employee:install</code>.</li>
        <li>Start the user UI on port 4000 with <code>npm run user:dev</code> (or build via <code>npm run user:build</code> then <code>npm run user:start</code>).</li>
        <li>Start the employee UI on port 4001 with <code>npm run employee:dev</code> (or build via <code>npm run employee:build</code> then <code>npm run employee:start</code>).</li>
      </ol>
      <p>Keep this server running with <code>npm start</code>. It listens on <code>http://localhost:${PORT}</code> and exposes the <code>/ws</code> WebSocket endpoint.</p>
    </main>
  </body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

