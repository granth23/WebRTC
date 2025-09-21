# React WebRTC Rooms

This project provides a minimal WebRTC demo that lets two people create and join ad-hoc video rooms using a short code. It contains:

- A lightweight signaling server implemented in Node.js without third-party dependencies
- A React front-end (delivered via CDN) that handles room creation/joining and WebRTC peer connections

## Getting started

1. **Install Node.js** (version 18 or later recommended).
2. **Start the server:**

   ```bash
   npm start
   ```

   The server runs on [http://localhost:3000](http://localhost:3000) by default.

3. **Open the app** in your browser and allow camera/microphone access when prompted.
4. One participant clicks **Create Room** to receive a code and shares it with the other person.
5. The second participant enters the shared code and clicks **Join Room**.
6. Once both are connected, a peer-to-peer WebRTC video call is established.

> **Note:** The front-end uses CDN bundles for React and Babel to avoid build tooling, so an internet connection is required when loading the page.

## How it works

- The Node.js server serves static assets from the `public` directory and performs the WebSocket signaling handshake.
- Room membership and signaling messages (offer, answer, ICE candidates) are relayed through the WebSocket connection.
- A maximum of two participants can occupy a room simultaneously. If one participant leaves, the remaining user becomes the host and can accept a new peer using the same code.

## Project structure

```
├── package.json
├── public
│   ├── app.jsx
│   ├── index.html
│   └── styles.css
└── server.js
```
