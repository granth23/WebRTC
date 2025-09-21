import { useEffect, useRef, useState } from 'react';

const INITIAL_STATUS = 'Connected employees will see customers waiting to be helped.';
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

function App() {
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState('');
  const [availableUsers, setAvailableUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [sessionState, setSessionState] = useState('idle');
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState('');

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
        setError('Camera and microphone access are required to help customers.');
        setStatus('Grant camera and microphone access to accept sessions.');
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
    setupSocket();
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
      setStatus('Connected to coordination server. Waiting for users...');
      socket.send(JSON.stringify({ type: 'employee-ready' }));
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
      setSelectedUser(null);
      setSessionState('idle');
      setError('');
      if (userInitiated) {
        setStatus('Disconnected. Use the list to join another customer when you are ready.');
      } else {
        setStatus('Connection to the coordination server was lost. Attempting to reconnect...');
        setError('Connection closed unexpectedly. Refresh if reconnection fails.');
        setTimeout(() => {
          setupSocket();
        }, 1000);
      }
    });

    socket.addEventListener('error', () => {
      setError('A connection error occurred.');
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
        const label = selectedUser ? selectedUser.name : 'customer';
        setStatus(`You are connected with ${label}.`);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnected(false);
        setStatus(`Connection state: ${pc.connectionState}.`);
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
      setStatus('Starting the session...');
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
      setStatus('Answer sent to the customer.');
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
      setStatus('Customer accepted the offer.');
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
      case 'user-list': {
        const list = Array.isArray(message.users) ? message.users : [];
        setAvailableUsers(list);
        if (list.length === 0 && sessionState === 'idle') {
          setStatus('No customers are waiting. You will be notified when someone joins.');
        } else if (list.length > 0 && sessionState === 'idle') {
          setStatus('Select a customer below to join their session.');
        }
        break;
      }
      case 'joined': {
        setRoomId(message.roomId);
        setError('');
        setSessionState('connecting');
        if (message.hostName) {
          setSelectedUser((prev) => prev ?? { roomId: message.roomId, name: message.hostName });
        }
        const label = message.hostName || (selectedUser ? selectedUser.name : 'customer');
        setStatus(`Joining session with ${label}. Preparing connection...`);
        break;
      }
      case 'ready':
        setStatus('Customer is ready. Establishing the call...');
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
        setRoomId('');
        setSessionState('idle');
        setSelectedUser(null);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        setStatus('The customer left the session. Select another name to help.');
        break;
      case 'error':
        setError(message.message || 'An unknown error occurred.');
        setStatus(`Error: ${message.message}`);
        setSessionState('idle');
        setSelectedUser(null);
        setRoomId('');
        cleanupPeer();
        break;
      default:
        break;
    }
  }

  function connectToUser(user) {
    if (!user || sessionState === 'connecting' || sessionState === 'call') {
      return;
    }
    setSelectedUser(user);
    setStatus(`Connecting to ${user.name}...`);
    setError('');
    setSessionState('connecting');
    setupSocket((socket) => {
      socket.send(JSON.stringify({ type: 'join', roomId: user.roomId }));
    });
  }

  function handleLeaveSession() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'leave' }));
    }
    cleanupPeer();
    setConnected(false);
    setRoomId('');
    setSelectedUser(null);
    setSessionState('idle');
    setStatus('Session ended. Select another customer when you are ready.');
    setError('');
  }

  const busy = sessionState === 'connecting' || sessionState === 'call';

  return (
    <div className="page">
      <header>
        <h1>Employee Console</h1>
        <p>Pick a customer from the queue to start a secure WebRTC session.</p>
      </header>

      <main className="layout">
        <section className="controls">
          <div className="card queue">
            <h2>Waiting customers</h2>
            {availableUsers.length === 0 ? (
              <p className="empty">No customers in the queue.</p>
            ) : (
              <ul>
                {availableUsers.map((user) => (
                  <li key={user.roomId}>
                    <button type="button" onClick={() => connectToUser(user)} disabled={busy}>
                      {user.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {busy && <p className="hint">Finish the active session before joining another customer.</p>}
          </div>

          <div className="card status">
            <h2>Session status</h2>
            <p>{status}</p>
            {selectedUser && <p className="selected">Current customer: <strong>{selectedUser.name}</strong></p>}
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
            <h3>Customer</h3>
            <video ref={remoteVideoRef} autoPlay playsInline></video>
          </div>
        </section>

        {connected && <div className="call-indicator">You are assisting {selectedUser ? selectedUser.name : 'a customer'}.</div>}
      </main>
    </div>
  );
}

export default App;
