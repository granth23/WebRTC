import { useEffect, useRef, useState } from 'react';

const INITIAL_STATUS = 'Create a room or join with a shared code to start a call.';
const DEFAULT_SIGNALING_PATH = import.meta.env.VITE_SIGNALING_PATH ?? '/ws';

function resolveSignalingUrl() {
  const explicit = (import.meta.env.VITE_SIGNALING_URL || '').trim();
  if (explicit.length > 0) {
    return explicit;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const path = DEFAULT_SIGNALING_PATH.startsWith('/')
    ? DEFAULT_SIGNALING_PATH
    : `/${DEFAULT_SIGNALING_PATH}`;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}${path}`;
}

function App() {
  const [roomCode, setRoomCode] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [isHost, setIsHost] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const manualCloseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function initMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (!cancelled) {
          localStreamRef.current = stream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
        }
      } catch (err) {
        console.error('Media error', err);
        setError('Unable to access camera or microphone. Please ensure permissions are granted.');
        setStatus('Camera or microphone permission is required for the call.');
      }
    }

    initMedia();

    return () => {
      cancelled = true;
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && roomCode) {
        wsRef.current.send(JSON.stringify({ type: 'leave' }));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [roomCode]);

  function setupSocket(onOpen) {
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      if (onOpen) {
        if (existing.readyState === WebSocket.OPEN) {
          onOpen(existing);
        } else {
          existing.addEventListener('open', () => onOpen(existing), { once: true });
        }
      }
      return existing;
    }

    const url = resolveSignalingUrl();
    const socket = new WebSocket(url);
    wsRef.current = socket;
    manualCloseRef.current = false;

    socket.addEventListener('open', () => {
      setStatus('Connected to signaling server.');
      if (onOpen) {
        onOpen(socket);
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleSignal(payload);
      } catch (err) {
        console.error('Failed to parse message', err);
      }
    });

    socket.addEventListener('close', () => {
      const userInitiated = manualCloseRef.current;
      manualCloseRef.current = false;
      setStatus(
        userInitiated ? 'Left the room. Create a new one or join with a code.' : 'Disconnected from signaling server.'
      );
      setConnected(false);
      cleanupPeer();
      setRoomCode('');
      setIsHost(false);
    });

    socket.addEventListener('error', () => {
      setError('A signaling connection error occurred.');
    });

    return socket;
  }

  function sendSignal(message) {
    const socket = setupSocket();
    const payload = JSON.stringify(message);

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => socket.send(payload), { once: true });
    }
  }

  function getPeerConnection() {
    if (pcRef.current) {
      return pcRef.current;
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    });

    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ type: 'candidate', candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnected(true);
        setStatus('Connected to peer.');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnected(false);
        setStatus(`Connection state: ${pc.connectionState}. Attempting to recover...`);
      }
    };

    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    return pc;
  }

  async function startOffer() {
    try {
      const pc = getPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', offer });
      setStatus('Sending offer to peer...');
    } catch (err) {
      console.error('Failed to create offer', err);
      setError('Unable to start the WebRTC offer.');
    }
  }

  async function handleOffer(offer) {
    try {
      const pc = getPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', answer });
      setStatus('Offer received. Answer sent.');
    } catch (err) {
      console.error('Error handling offer', err);
      setError('Could not process the incoming offer.');
    }
  }

  async function handleAnswer(answer) {
    try {
      const pc = getPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingCandidates();
      setStatus('Answer received. Finalizing connection...');
    } catch (err) {
      console.error('Error handling answer', err);
      setError('Could not apply the remote answer.');
    }
  }

  function handleCandidate(candidate) {
    const rtcCandidate = new RTCIceCandidate(candidate);
    if (pcRef.current && pcRef.current.remoteDescription) {
      pcRef.current.addIceCandidate(rtcCandidate).catch((err) => {
        console.error('Error adding candidate', err);
      });
    } else {
      pendingCandidatesRef.current.push(rtcCandidate);
    }
  }

  async function flushPendingCandidates() {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      return;
    }

    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('Error flushing candidate', err);
      }
    }
  }

  function cleanupPeer() {
    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch (err) {
        console.error('Error closing peer connection', err);
      }
      pcRef.current = null;
    }
    pendingCandidatesRef.current.length = 0;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }

  function handleSignal(message) {
    switch (message.type) {
      case 'created':
        setRoomCode(message.roomId);
        setIsHost(true);
        setError('');
        setStatus(`Room ${message.roomId} created. Share the code with a friend.`);
        setRoomInput('');
        break;
      case 'joined':
        setRoomCode(message.roomId);
        setIsHost(false);
        setError('');
        setStatus(`Joined room ${message.roomId}. Waiting for the call to start...`);
        setRoomInput('');
        break;
      case 'ready':
        setStatus('Peer joined! Establishing connection...');
        if (message.initiator) {
          startOffer();
        } else {
          getPeerConnection();
        }
        break;
      case 'offer':
        handleOffer(message.offer);
        break;
      case 'answer':
        handleAnswer(message.answer);
        break;
      case 'candidate':
        handleCandidate(message.candidate);
        break;
      case 'peer-left':
        setConnected(false);
        cleanupPeer();
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        if (typeof message.isHost === 'boolean') {
          setIsHost(message.isHost);
        }
        setStatus(message.isHost ? 'Peer left the room. Waiting for someone new to join.' : 'Peer left the room.');
        break;
      case 'error':
        setError(message.message || 'An unknown error occurred.');
        setStatus(`Error: ${message.message}`);
        break;
      default:
        break;
    }
  }

  function handleCreateRoom() {
    setError('');
    const desiredCode = generateRoomCode();
    setStatus('Creating room...');
    setupSocket((socket) => {
      socket.send(JSON.stringify({ type: 'create', roomId: desiredCode }));
    });
  }

  function handleJoinRoom() {
    const code = roomInput.trim().toUpperCase();
    if (!code) {
      setError('Enter a room code to join.');
      return;
    }
    setError('');
    setStatus(`Joining room ${code}...`);
    setupSocket((socket) => {
      socket.send(JSON.stringify({ type: 'join', roomId: code }));
    });
  }

  function handleLeaveRoom() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      manualCloseRef.current = true;
      wsRef.current.send(JSON.stringify({ type: 'leave' }));
      wsRef.current.close();
    } else {
      cleanupPeer();
      setConnected(false);
      setRoomCode('');
      setIsHost(false);
      setStatus('Left the room. Create a new one or join with a code.');
    }
  }

  async function handleCopyCode() {
    if (!roomCode || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(roomCode);
      setStatus('Room code copied to clipboard!');
    } catch (err) {
      console.error('Copy failed', err);
      setError('Unable to copy the room code. Copy it manually.');
    }
  }

  function generateRoomCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  return (
    <div className="container">
      <h1>React WebRTC Rooms</h1>
      <div className="controls">
        <div className="control-card">
          <h2>Create a room</h2>
          <p>Generate a private code and share it with a friend to start a secure peer-to-peer call.</p>
          <button type="button" onClick={handleCreateRoom} disabled={Boolean(roomCode)}>
            {roomCode ? 'Room Active' : 'Create Room'}
          </button>
          {roomCode && (
            <p className="room-code">
              Code: <span>{roomCode}</span>
              <button type="button" onClick={handleCopyCode}>Copy</button>
            </p>
          )}
        </div>

        <div className="control-card">
          <h2>Join a room</h2>
          <p>Enter the room code shared with you to join the conversation.</p>
          <input
            type="text"
            value={roomInput}
            onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
            placeholder="Enter room code"
            maxLength={8}
            disabled={Boolean(roomCode)}
          />
          <button type="button" onClick={handleJoinRoom} disabled={Boolean(roomCode)}>
            Join Room
          </button>
        </div>

        <div className="control-card status">
          <h2>Status</h2>
          <p>{status}</p>
          {error && <p className="error">{error}</p>}
          {roomCode && (
            <>
              <p className="role-indicator">You are the {isHost ? 'host' : 'guest'} of this room.</p>
              <button type="button" onClick={handleLeaveRoom}>
                Leave Room
              </button>
            </>
          )}
        </div>
      </div>

      <div className="videos">
        <div className="video-wrapper">
          <h3>Your preview</h3>
          <video ref={localVideoRef} autoPlay playsInline muted></video>
        </div>
        <div className="video-wrapper">
          <h3>Remote participant</h3>
          <video ref={remoteVideoRef} autoPlay playsInline></video>
        </div>
      </div>

      {connected && <div className="connected">You are now on a call.</div>}
    </div>
  );
}

export default App;
