import { useEffect, useRef, useState } from 'react';

const INITIAL_STATUS = 'Enter your name to begin a support session.';
const DEFAULT_SIGNALING_PATH = import.meta.env.VITE_SIGNALING_PATH ?? '/ws';

function resolveSignalingUrl() {
  const explicit = (import.meta.env.VITE_SIGNALING_URL || '').trim();
  if (explicit.length > 0) {
    return explicit;
  }
  if (typeof window === 'undefined') {
    return '';
  }
  const path = DEFAULT_SIGNALING_PATH.startsWith('/') ? DEFAULT_SIGNALING_PATH : `/${DEFAULT_SIGNALING_PATH}`;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}${path}`;
}

function sanitizeDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

function App() {
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState('');
  const [sessionState, setSessionState] = useState('idle');
  const [roomId, setRoomId] = useState('');
  const [connected, setConnected] = useState(false);

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
        setError('Camera and microphone access are required to start a session.');
        setStatus('Grant access to your camera and microphone to continue.');
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
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && roomId) {
        wsRef.current.send(JSON.stringify({ type: 'leave' }));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [roomId]);

  useEffect(() => () => {
    if (wsRef.current) {
      manualCloseRef.current = true;
      wsRef.current.close();
    }
  }, []);

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
      setStatus('Connected to coordination server.');
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
      cleanupPeer();
      setConnected(false);
      setRoomId('');
      if (userInitiated) {
        setStatus('Session ended. Enter your name to start again.');
      } else {
        setStatus('Connection to the coordination server was lost.');
        setError('Connection closed unexpectedly. Refresh or start again.');
      }
      setSessionState('idle');
    });

    socket.addEventListener('error', () => {
      setError('A connection error occurred. Please retry.');
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
        setSessionState('call');
        setStatus('You are connected to an employee.');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnected(false);
        setStatus(`Connection state: ${pc.connectionState}. Waiting for reconnection...`);
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
      setStatus('Preparing a connection for the employee...');
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
      setStatus('Employee offer received. Responding now.');
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
      setStatus('Employee accepted the offer. Finalizing connection...');
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
      case 'registered':
      case 'created':
        setRoomId(message.roomId);
        setSessionState('queue');
        setError('');
        setStatus('Waiting for an employee to join your session...');
        break;
      case 'ready':
        setStatus('Employee connected. Establishing call...');
        setSessionState('connecting');
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
        setSessionState('queue');
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        setStatus('The employee left the call. Waiting for the next available person.');
        break;
      case 'error':
        setError(message.message || 'An unknown error occurred.');
        setStatus(`Error: ${message.message}`);
        break;
      default:
        break;
    }
  }

  function beginSession(event) {
    event.preventDefault();
    const trimmed = sanitizeDisplayName(displayName);
    if (!trimmed) {
      setError('Please provide your name to continue.');
      return;
    }
    setDisplayName(trimmed);
    setError('');
    setStatus('Connecting you with an employee...');
    setSessionState('registering');
    setupSocket((socket) => {
      socket.send(JSON.stringify({ type: 'register-user', name: trimmed }));
    });
  }

  function handleLeaveSession() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      manualCloseRef.current = true;
      wsRef.current.send(JSON.stringify({ type: 'leave' }));
      wsRef.current.close();
    } else {
      cleanupPeer();
      setConnected(false);
      setRoomId('');
      setSessionState('idle');
      setStatus(INITIAL_STATUS);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Customer Session</h1>
        <p>Start a video session and we will connect you with the next available employee.</p>
      </header>

      <main className="layout">
        <section className="controls">
          <form className="card" onSubmit={beginSession}>
            <h2>Start a session</h2>
            <label htmlFor="display-name">Your name</label>
            <input
              id="display-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Jane Doe"
              maxLength={48}
              disabled={sessionState !== 'idle'}
              autoComplete="name"
              required
            />
            <button type="submit" disabled={sessionState !== 'idle'}>
              Start session
            </button>
          </form>

          <div className="card status">
            <h2>Status</h2>
            <p>{status}</p>
            {error && <p className="error">{error}</p>}
            {roomId && (
              <p className="session-id">
                Session ID: <code>{roomId}</code>
              </p>
            )}
            {sessionState !== 'idle' && (
              <button type="button" onClick={handleLeaveSession} className="leave">
                End session
              </button>
            )}
          </div>
        </section>

        <section className="videos">
          <div className="video-card">
            <h3>Your camera</h3>
            <video ref={localVideoRef} autoPlay playsInline muted></video>
          </div>
          <div className="video-card">
            <h3>Employee</h3>
            <video ref={remoteVideoRef} autoPlay playsInline></video>
          </div>
        </section>

        {connected && <div className="call-indicator">You are connected to an employee.</div>}
      </main>
    </div>
  );
}

export default App;
