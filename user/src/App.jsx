import { useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';

const INITIAL_STATUS = 'Complete the application steps to begin your verification session.';
const READY_STATUS = 'Review your details and start the verification call when you are ready.';
const DEFAULT_SIGNALING_PATH = import.meta.env.VITE_SIGNALING_PATH ?? '/ws';
const LOCAL_SIGNALING_FALLBACK_PORTS = new Map([
  [5173, 3000],
  [5174, 3000],
  [5175, 3000],
  [4173, 3000],
  [4174, 3000],
  [4000, 3000],
  [4001, 3000]
]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLocalHostname(hostname) {
  if (!hostname) {
    return false;
  }
  if (LOCAL_HOSTS.has(hostname)) {
    return true;
  }
  if (hostname.startsWith('127.')) {
    return true;
  }
  if (hostname.startsWith('::ffff:127.')) {
    return true;
  }
  return false;
}
const PAN_REGEX = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;
const DOB_REGEX = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/;
const INVALID_NAME_CHARS = /[^A-Z0-9\s./-]/g;

const STEPS = [
  {
    id: 1,
    title: 'Personal details',
    description: 'Tell us how we can reach you during the loan process.'
  },
  {
    id: 2,
    title: 'Loan requirements',
    description: 'Share the loan amount, tenure, and your monthly income.'
  },
  {
    id: 3,
    title: 'Identity verification',
    description: 'Upload both sides of your PAN card for review.'
  },
  {
    id: 4,
    title: 'Video verification',
    description: 'Connect with a loan officer to finalise your application.'
  }
];

function resolveSignalingUrl() {
  const explicit = (import.meta.env.VITE_SIGNALING_URL || '').trim();
  if (explicit.length > 0) {
    return explicit;
  }
  if (typeof window === 'undefined') {
    return '';
  }
  const path = DEFAULT_SIGNALING_PATH.startsWith('/') ? DEFAULT_SIGNALING_PATH : `/${DEFAULT_SIGNALING_PATH}`;
  const pageProtocol = window.location.protocol;
  const wsProtocol = pageProtocol === 'https:' ? 'wss' : 'ws';
  const hostname = window.location.hostname;
  const parsedPort = Number.parseInt(window.location.port, 10);
  const defaultPort = pageProtocol === 'https:' ? 443 : 80;
  const isLocalHost = isLocalHostname(hostname);
  let targetPort = Number.isFinite(parsedPort) ? parsedPort : defaultPort;

  if (isLocalHost && LOCAL_SIGNALING_FALLBACK_PORTS.has(targetPort)) {
    targetPort = LOCAL_SIGNALING_FALLBACK_PORTS.get(targetPort);
  }

  const includePort = targetPort !== defaultPort && targetPort !== 0;
  const portSegment = includePort ? `:${targetPort}` : '';

  return `${wsProtocol}://${hostname}${portSegment}${path}`;
}

function sanitizeDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizePanNumber(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function isValidPanNumber(value) {
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(value);
}

function formatPanName(value) {
  if (!value) {
    return '';
  }
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalisePanDob(value) {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.replace(/[.]/g, '/').replace(/-/g, '/');
  const [day, month, year] = normalized.split('/');
  if (day && month && year) {
    const dd = Number.parseInt(day, 10);
    const mm = Number.parseInt(month, 10);
    let yyyy = Number.parseInt(year, 10);
    if (Number.isFinite(dd) && Number.isFinite(mm) && Number.isFinite(yyyy)) {
      if (yyyy < 100) {
        const currentYear = new Date().getFullYear();
        const currentCentury = Math.floor(currentYear / 100) * 100;
        const candidate = currentCentury + yyyy;
        yyyy = candidate > currentYear ? candidate - 100 : candidate;
      }
      const isoDate = new Date(Date.UTC(yyyy, mm - 1, dd));
      if (!Number.isNaN(isoDate.getTime())) {
        return isoDate.toISOString().slice(0, 10);
      }
    }
  }
  return trimmed;
}

function normaliseExtractedPan(value) {
  if (!value) {
    return '';
  }
  const cleaned = sanitizePanNumber(value);
  return isValidPanNumber(cleaned) ? cleaned : '';
}

function normalisePanName(value) {
  if (!value) {
    return '';
  }
  const cleaned = value
    .toUpperCase()
    .replace(INVALID_NAME_CHARS, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return formatPanName(cleaned);
}

function findPan(joined, lines) {
  const match = joined.match(PAN_REGEX);
  if (match) {
    return match[1];
  }
  for (const line of lines) {
    const candidate = sanitizePanNumber(line);
    if (isValidPanNumber(candidate)) {
      return candidate;
    }
  }
  return '';
}

function findByKeywords(lines, keywords) {
  const upperKeywords = keywords.map((keyword) => keyword.toUpperCase());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const upper = line.toUpperCase();
    for (const keyword of upperKeywords) {
      if (upper.includes(keyword)) {
        const start = upper.indexOf(keyword) + keyword.length;
        let after = line.slice(start).replace(/^[:\s-]+/, '');
        if (!after && line.includes(':')) {
          after = line.split(':', 2)[1]?.trim() ?? '';
        }
        if (after) {
          return after;
        }
        if (index + 1 < lines.length) {
          return lines[index + 1];
        }
      }
    }
  }
  return '';
}

function findFirstMatch(pattern, text) {
  const match = text.match(pattern);
  return match ? match[1] : '';
}

function parsePanText(text) {
  if (!text) {
    return { panNumber: '', name: '', fatherName: '', dob: '' };
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(' ');

  const panNumber = normaliseExtractedPan(findPan(joined, lines));
  const name = normalisePanName(findByKeywords(lines, ['NAME']));
  const fatherName = normalisePanName(
    findByKeywords(lines, ["FATHER'S NAME", 'FATHERS NAME', 'FATHER NAME', 'FATHER'])
  );
  let dob = normalisePanDob(findByKeywords(lines, ['DOB', 'DATE OF BIRTH', 'BIRTH']));
  if (!dob) {
    dob = normalisePanDob(findFirstMatch(DOB_REGEX, joined));
  }

  return { panNumber, name, fatherName, dob };
}

function formatCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return value || '—';
  }
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(amount);
  } catch (err) {
    return `₹${amount.toLocaleString('en-IN')}`;
  }
}

function formatDate(value) {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function App() {
  const [currentStep, setCurrentStep] = useState(1);
  const [wizardError, setWizardError] = useState('');
  const [customerInfo, setCustomerInfo] = useState({
    fullName: '',
    phone: '',
    email: '',
    address: ''
  });
  const [financialInfo, setFinancialInfo] = useState({
    dob: '',
    amount: '',
    tenure: '',
    income: ''
  });
  const [documents, setDocuments] = useState({
    panFront: null
  });

  const [panDetails, setPanDetails] = useState({
    panNumber: '',
    name: '',
    fatherName: '',
    dob: ''
  });

  const [panExtraction, setPanExtraction] = useState({
    status: 'idle',
    message: ''
  });

  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState('');
  const [sessionState, setSessionState] = useState('idle');
  const [roomId, setRoomId] = useState('');
  const [connected, setConnected] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [completed, setCompleted] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const manualCloseRef = useRef(false);
  const panExtractionJobRef = useRef(0);
  const finalizedRef = useRef(false);

  useEffect(() => {
    const video = localVideoRef.current;
    const stream = localStreamRef.current;

    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [currentStep]);

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

  useEffect(
    () => () => {
      if (wsRef.current) {
        manualCloseRef.current = true;
        wsRef.current.close();
      }
    },
    []
  );

  useEffect(() => {
    if (currentStep === 4 && sessionState === 'idle' && !roomId) {
      setStatus((prev) => (prev === INITIAL_STATUS ? READY_STATUS : prev));
      setError('');
    }
  }, [currentStep, sessionState, roomId]);

  useEffect(() => {
    setWizardError('');
  }, [currentStep]);

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
      setStatus('Connected to the coordination server.');
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
      if (finalizedRef.current) {
        return;
      }
      if (userInitiated) {
        setStatus('Session ended. You can start a new verification when you\'re ready.');
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
        setStatus('You are connected to a loan officer.');
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
      setStatus('Preparing a connection for your loan officer...');
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
      setStatus('Loan officer offer received. Responding now.');
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
      setStatus('Loan officer accepted the offer. Finalising connection...');
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
        setStatus('Waiting for a loan officer to join your session...');
        if (message.verificationCode) {
          setVerificationCode(message.verificationCode);
        }
        break;
      case 'ready':
        setStatus('Loan officer connected. Establishing call...');
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
        if (finalizedRef.current) {
          break;
        }
        setConnected(false);
        cleanupPeer();
        setSessionState('queue');
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        setStatus('The loan officer left the call. Waiting for the next available person.');
        break;
      case 'verification-complete':
        {
          const code = message.verificationCode || verificationCode;
          if (message.verificationCode) {
            setVerificationCode(message.verificationCode);
          }
          finalizeSession(code);
        }
        break;
      case 'verification-error':
        setError(message.message || 'Verification failed. Please try again.');
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
    if (event) {
      event.preventDefault();
    }
    if (sessionState !== 'idle') {
      return;
    }
    const trimmed = sanitizeDisplayName(customerInfo.fullName);
    if (!trimmed) {
      setWizardError('Please return to Step 1 and provide your full name before starting.');
      setCurrentStep(1);
      return;
    }
    setError('');
    setStatus('Connecting you with a loan officer...');
    setSessionState('registering');
    setCompleted(false);
    setVerificationCode('');
    finalizedRef.current = false;
    setupSocket((socket) => {
      const panNumber = sanitizePanNumber(panDetails.panNumber);
      const details = {
        panNumber,
        panName: panDetails.name ? formatPanName(panDetails.name) : '',
        dob: panDetails.dob ? normalisePanDob(panDetails.dob) : ''
      };
      socket.send(
        JSON.stringify({
          type: 'register-user',
          name: trimmed,
          details
        })
      );
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
    setVerificationCode('');
    setCompleted(false);
    finalizedRef.current = false;
  }

  function finalizeSession(codeValue) {
    if (finalizedRef.current) {
      return;
    }
    finalizedRef.current = true;
    cleanupPeer();
    setConnected(false);
    setStatus('Verification complete. Thank you for finishing the process.');
    setError('');
    setSessionState('completed');
    setCompleted(true);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    const finalCode = codeValue || verificationCode;

    const summary = {
      customerInfo,
      financialInfo,
      panDetails,
      documents: {
        panFront: documents.panFront ? documents.panFront.name : null
      },
      verificationCode: finalCode,
      roomId
    };
    console.log('Loan application completed', summary);

    if (finalCode) {
      setVerificationCode(finalCode);
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      manualCloseRef.current = true;
      wsRef.current.send(JSON.stringify({ type: 'leave' }));
      wsRef.current.close();
    }
  }

  function handlePersonalSubmit(event) {
    event.preventDefault();
    const trimmedName = sanitizeDisplayName(customerInfo.fullName);
    const trimmedPhone = customerInfo.phone.trim();
    const trimmedEmail = customerInfo.email.trim();
    const trimmedAddress = customerInfo.address.trim();

    if (!trimmedName) {
      setWizardError('Please enter your full name.');
      return;
    }
    if (!trimmedPhone) {
      setWizardError('Please provide a contact number.');
      return;
    }
    if (!trimmedEmail || !/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setWizardError('Enter a valid email address.');
      return;
    }
    if (!trimmedAddress) {
      setWizardError('Please share your current address.');
      return;
    }

    setCustomerInfo({
      fullName: trimmedName,
      phone: trimmedPhone,
      email: trimmedEmail,
      address: trimmedAddress
    });
    setWizardError('');
    setCurrentStep(2);
  }

  function handleFinancialSubmit(event) {
    event.preventDefault();
    const dob = financialInfo.dob;
    const amount = Number(financialInfo.amount);
    const tenure = Number(financialInfo.tenure);
    const income = Number(financialInfo.income);

    if (!dob) {
      setWizardError('Select your date of birth.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setWizardError('Enter a loan amount greater than zero.');
      return;
    }
    if (!Number.isFinite(tenure) || tenure <= 0) {
      setWizardError('Specify the desired tenure in months.');
      return;
    }
    if (!Number.isFinite(income) || income <= 0) {
      setWizardError('Share your estimated monthly income.');
      return;
    }

    setFinancialInfo({
      dob,
      amount: String(amount),
      tenure: String(tenure),
      income: String(income)
    });
    setWizardError('');
    setCurrentStep(3);
  }

  function handleDocumentSubmit(event) {
    event.preventDefault();
    if (!documents.panFront) {
      setWizardError('Please upload the front of your PAN card.');
      return;
    }
    const sanitisedPan = sanitizePanNumber(panDetails.panNumber);
    if (!isValidPanNumber(sanitisedPan)) {
      setWizardError('Enter a valid 10-character PAN card number.');
      return;
    }

    setPanDetails((prev) => ({
      ...prev,
      panNumber: sanitisedPan,
      name: formatPanName(prev.name),
      fatherName: formatPanName(prev.fatherName),
      dob: prev.dob ? normalisePanDob(prev.dob) : ''
    }));
    setWizardError('');
    setStatus(READY_STATUS);
    setError('');
    setCurrentStep(4);
  }

  function handleDocumentChange(field, files) {
    const [file] = files || [];
    setDocuments((prev) => ({
      ...prev,
      [field]: file || null
    }));
    setWizardError('');
    if (field === 'panFront') {
      if (file) {
        const jobId = panExtractionJobRef.current + 1;
        panExtractionJobRef.current = jobId;
        extractPanDetails(file, jobId);
      } else {
        panExtractionJobRef.current += 1;
        setPanExtraction({ status: 'idle', message: '' });
        setPanDetails((prev) => ({
          ...prev,
          name: '',
          fatherName: '',
          dob: ''
        }));
      }
    }
  }

  function handlePanNumberChange(event) {
    const sanitised = sanitizePanNumber(event.target.value);
    setPanDetails((prev) => ({
      ...prev,
      panNumber: sanitised
    }));
  }

  function handlePanNameChange(event) {
    const { value } = event.target;
    setPanDetails((prev) => ({
      ...prev,
      name: value
    }));
  }

  function handlePanFatherNameChange(event) {
    const { value } = event.target;
    setPanDetails((prev) => ({
      ...prev,
      fatherName: value
    }));
  }

  function handlePanDobChange(event) {
    const { value } = event.target;
    setPanDetails((prev) => ({
      ...prev,
      dob: value
    }));
  }

  async function extractPanDetails(file, jobId) {
    setPanExtraction({ status: 'loading', message: 'Extracting PAN details…' });

    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: (info) => {
          if (jobId !== panExtractionJobRef.current) {
            return;
          }
          if (!info?.status) {
            return;
          }
          const progress = info.progress ? Math.round(info.progress * 100) : 0;
          let message = 'Extracting PAN details…';
          if (info.status !== 'recognizing text') {
            message = progress > 0 && progress < 100 ? `Preparing on-device OCR… ${progress}%` : 'Preparing on-device OCR…';
          } else if (progress > 0 && progress < 100) {
            message = `Extracting PAN details… ${progress}%`;
          }
          setPanExtraction({ status: 'loading', message });
        }
      });

      if (jobId !== panExtractionJobRef.current) {
        return;
      }

      const text = result?.data?.text ?? '';
      const parsed = parsePanText(text);

      if (jobId !== panExtractionJobRef.current) {
        return;
      }

      setPanDetails((prev) => ({
        panNumber: parsed.panNumber || prev.panNumber,
        name: parsed.name || prev.name,
        fatherName: parsed.fatherName || prev.fatherName,
        dob: parsed.dob || prev.dob
      }));

      if (jobId !== panExtractionJobRef.current) {
        return;
      }

      const hasAutoFill = Boolean(parsed.panNumber || parsed.name || parsed.fatherName || parsed.dob);

      setPanExtraction({
        status: hasAutoFill ? 'success' : 'warning',
        message: hasAutoFill
          ? 'We auto-filled details from your PAN card. Please review them below.'
          : 'We could not read details automatically. You can fill them in manually.'
      });
    } catch (err) {
      if (jobId !== panExtractionJobRef.current) {
        return;
      }
      console.error('PAN extraction failed', err);
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'On-device PAN extraction failed. Please fill in the details manually.';
      setPanExtraction({ status: 'error', message });
    }
  }

  function goToPreviousStep() {
    if (currentStep === 1) {
      return;
    }
    if (currentStep === 4 && sessionState !== 'idle') {
      return;
    }
    setCurrentStep((step) => Math.max(1, step - 1));
  }

  function renderStepContent() {
    if (completed) {
      return (
        <div className="card thank-you-card">
          <h2>Thank you</h2>
          <p>
            Your loan verification call is complete. Our loan officer has recorded your details and will reach out with the next
            steps shortly.
          </p>
          <div className="thank-you-details">
            <div>
              <span className="label">Applicant</span>
              <strong>{customerInfo.fullName || '—'}</strong>
            </div>
            <div>
              <span className="label">Verification code</span>
              <code>{verificationCode || '—'}</code>
            </div>
          </div>
          <p className="thank-you-note">You may close this window. A confirmation has been logged for our records.</p>
        </div>
      );
    }

    switch (currentStep) {
      case 1:
        return (
          <form className="card form-card" onSubmit={handlePersonalSubmit}>
            <h2>Applicant information</h2>
            <p className="helper-text">We will use these details to keep you informed about your loan request.</p>
            {wizardError && <p className="wizard-error">{wizardError}</p>}
            <label htmlFor="full-name">Full name</label>
            <input
              id="full-name"
              type="text"
              value={customerInfo.fullName}
              onChange={(event) => setCustomerInfo((prev) => ({ ...prev, fullName: event.target.value }))}
              placeholder="Jane Doe"
              maxLength={64}
              autoComplete="name"
              required
            />

            <label htmlFor="phone">Phone number</label>
            <input
              id="phone"
              type="tel"
              value={customerInfo.phone}
              onChange={(event) => setCustomerInfo((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="9876543210"
              autoComplete="tel"
              required
            />

            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={customerInfo.email}
              onChange={(event) => setCustomerInfo((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="name@example.com"
              autoComplete="email"
              required
            />

            <label htmlFor="address">Current address</label>
            <textarea
              id="address"
              value={customerInfo.address}
              onChange={(event) => setCustomerInfo((prev) => ({ ...prev, address: event.target.value }))}
              placeholder="Street, city, state, PIN"
              rows={3}
              required
            />

            <div className="form-actions">
              <button type="submit" className="primary-button">
                Continue
              </button>
            </div>
          </form>
        );
      case 2:
        return (
          <form className="card form-card" onSubmit={handleFinancialSubmit}>
            <h2>Loan preferences</h2>
            <p className="helper-text">Help us tailor the loan plan that works best for you.</p>
            {wizardError && <p className="wizard-error">{wizardError}</p>}
            <label htmlFor="dob">Date of birth</label>
            <input
              id="dob"
              type="date"
              value={financialInfo.dob}
              onChange={(event) => setFinancialInfo((prev) => ({ ...prev, dob: event.target.value }))}
              required
            />

            <label htmlFor="loan-amount">Loan amount (₹)</label>
            <input
              id="loan-amount"
              type="number"
              min="1"
              step="1"
              value={financialInfo.amount}
              onChange={(event) => setFinancialInfo((prev) => ({ ...prev, amount: event.target.value }))}
              placeholder="500000"
              required
            />

            <label htmlFor="tenure">Tenure (months)</label>
            <input
              id="tenure"
              type="number"
              min="1"
              step="1"
              value={financialInfo.tenure}
              onChange={(event) => setFinancialInfo((prev) => ({ ...prev, tenure: event.target.value }))}
              placeholder="60"
              required
            />

            <label htmlFor="income">Estimated monthly income (₹)</label>
            <input
              id="income"
              type="number"
              min="1"
              step="1"
              value={financialInfo.income}
              onChange={(event) => setFinancialInfo((prev) => ({ ...prev, income: event.target.value }))}
              placeholder="75000"
              required
            />

            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={goToPreviousStep}>
                Back
              </button>
              <button type="submit" className="primary-button">
                Continue
              </button>
            </div>
          </form>
        );
      case 3:
        return (
          <form className="card form-card" onSubmit={handleDocumentSubmit}>
            <h2>PAN verification</h2>
            <p className="helper-text">
              Upload a clear image of the front of your PAN card so we can validate your details before the
              video call.
            </p>
            {wizardError && <p className="wizard-error">{wizardError}</p>}

            <label htmlFor="pan-front">PAN card &mdash; front side</label>
            <input
              id="pan-front"
              type="file"
              accept="image/*,.pdf"
              onChange={(event) => handleDocumentChange('panFront', event.target.files)}
            />
            {documents.panFront && <p className="document-pill">{documents.panFront.name}</p>}

            <label htmlFor="pan-number">PAN card number</label>
            <input
              id="pan-number"
              type="text"
              inputMode="text"
              autoComplete="off"
              value={panDetails.panNumber}
              onChange={handlePanNumberChange}
              placeholder="ABCDE1234F"
              maxLength={10}
              required
            />
            <p className="field-hint">We auto-fill this when possible. You can edit it if the OCR misses a character.</p>

            <section className="pan-summary" aria-live="polite">
              <div className="pan-summary-header">
                <h3>Details detected</h3>
                <p className={`pan-status ${panExtraction.status}`}>
                  {panExtraction.status === 'idle'
                    ? 'Upload a crisp scan to auto-fill the information below.'
                    : panExtraction.message}
                </p>
                <p className="pan-edit-note">Update any field so it matches your PAN card exactly.</p>
              </div>
              <div className="pan-fields-grid">
                <div className="pan-field">
                  <label htmlFor="pan-name">Name on card</label>
                  <input
                    id="pan-name"
                    type="text"
                    value={panDetails.name}
                    onChange={handlePanNameChange}
                    placeholder="Enter the name as printed"
                    maxLength={64}
                  />
                </div>
                <div className="pan-field">
                  <label htmlFor="pan-father-name">Father&apos;s name</label>
                  <input
                    id="pan-father-name"
                    type="text"
                    value={panDetails.fatherName}
                    onChange={handlePanFatherNameChange}
                    placeholder="Enter the father&apos;s name"
                    maxLength={64}
                  />
                </div>
                <div className="pan-field">
                  <label htmlFor="pan-dob">Date of birth</label>
                  <input
                    id="pan-dob"
                    type="text"
                    value={panDetails.dob}
                    onChange={handlePanDobChange}
                    placeholder="DD/MM/YYYY"
                    maxLength={32}
                  />
                </div>
              </div>
            </section>

            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={goToPreviousStep}>
                Back
              </button>
              <button type="submit" className="primary-button">
                Continue
              </button>
            </div>
          </form>
        );
      case 4:
        return (
          <>
            <div className="session-layout">
              <section className="controls">
                <div className="card session-card">
                  <h2>Review and start verification</h2>
                  <p className="helper-text">
                    Confirm the information below before you begin your live loan verification call.
                  </p>
                  <div className="summary">
                    <div>
                      <h3>Applicant</h3>
                      <dl>
                        <dt>Name</dt>
                        <dd>{customerInfo.fullName || '—'}</dd>
                        <dt>Phone</dt>
                        <dd>{customerInfo.phone || '—'}</dd>
                        <dt>Email</dt>
                        <dd>{customerInfo.email || '—'}</dd>
                        <dt>Address</dt>
                        <dd>{customerInfo.address || '—'}</dd>
                      </dl>
                    </div>
                    <div>
                      <h3>PAN details</h3>
                      <dl>
                        <dt>PAN number</dt>
                        <dd>{panDetails.panNumber || '—'}</dd>
                        <dt>Name on card</dt>
                        <dd>{panDetails.name || '—'}</dd>
                        <dt>Father&apos;s name</dt>
                        <dd>{panDetails.fatherName || '—'}</dd>
                        <dt>Date of birth</dt>
                        <dd>{panDetails.dob ? formatDate(panDetails.dob) : '—'}</dd>
                      </dl>
                    </div>
                    <div>
                      <h3>Loan details</h3>
                      <dl>
                        <dt>Date of birth</dt>
                        <dd>{formatDate(financialInfo.dob)}</dd>
                        <dt>Requested amount</dt>
                        <dd>{formatCurrency(financialInfo.amount)}</dd>
                        <dt>Tenure</dt>
                        <dd>{financialInfo.tenure ? `${financialInfo.tenure} months` : '—'}</dd>
                        <dt>Monthly income</dt>
                        <dd>{formatCurrency(financialInfo.income)}</dd>
                      </dl>
                    </div>
                  </div>
                  <div className="document-list">
                    <span>Documents:</span>
                    <div className="document-tags">
                      <span className="document-pill">
                        {documents.panFront ? `PAN front — ${documents.panFront.name}` : 'PAN front pending'}
                      </span>
                    </div>
                    {panExtraction.status === 'loading' && (
                      <p className="document-note loading">{panExtraction.message}</p>
                    )}
                    {panExtraction.status === 'warning' && (
                      <p className="document-note warning">{panExtraction.message}</p>
                    )}
                    {panExtraction.status === 'error' && (
                      <p className="document-note error">{panExtraction.message}</p>
                    )}
                    {panExtraction.status === 'success' && (
                      <p className="document-note success">{panExtraction.message}</p>
                    )}
                    {panExtraction.status === 'idle' && (
                      <p className="document-note idle">Upload your PAN card to auto-fill the verification details.</p>
                    )}
                  </div>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={goToPreviousStep}
                      disabled={sessionState !== 'idle'}
                      title={sessionState !== 'idle' ? 'End the current session before editing previous steps.' : undefined}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={beginSession}
                      disabled={sessionState !== 'idle'}
                    >
                      Begin verification call
                    </button>
                  </div>
                </div>

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
                  <p className="verification-code">
                    Verification code: <code>{verificationCode || 'Generating…'}</code>
                  </p>
                </div>
                <div className="video-card">
                  <h3>Loan officer</h3>
                  <video ref={remoteVideoRef} autoPlay playsInline></video>
                </div>
              </section>
            </div>
            {connected && !completed && <div className="call-indicator">You are connected to a loan officer.</div>}
          </>
        );
      default:
        return null;
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Loan management video verification</h1>
        <p>
          Follow the guided steps to submit your loan application details and finish with a secure video call with our loan
          officer.
        </p>
      </header>

      <ol className="stepper" role="list">
        {STEPS.map((step) => {
          const state = completed
            ? 'complete'
            : currentStep === step.id
            ? 'active'
            : currentStep > step.id
            ? 'complete'
            : 'upcoming';
          return (
            <li key={step.id} className={`step ${state}`}>
              <span className="step-index" aria-hidden="true">
                {step.id}
              </span>
              <div className="step-details">
                <p className="step-title">{step.title}</p>
                <p className="step-description">{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <main className={`layout step-${currentStep}`}>{renderStepContent()}</main>
    </div>
  );
}

export default App;
