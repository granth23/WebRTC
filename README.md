# React WebRTC Rooms

This repository hosts a production-ready React client and a lightweight Node.js signaling server that together deliver a two-party WebRTC calling experience. One participant can generate a room code, share it, and the peer joins with the code to establish a peer-to-peer video call.

## Project structure

```
├── client/               # React application bootstrapped with Vite
│   ├── index.html
│   ├── package.json
│   └── src/
│       ├── App.jsx
│       ├── App.css
│       └── main.jsx
├── server.js             # HTTP + WebSocket signaling server (no external deps)
├── package.json          # Server-side scripts and helpers
└── .gitignore
```

## Requirements

- Node.js 18 or newer
- Modern browser with camera & microphone permissions granted

## Local development

1. **Install client dependencies**

   ```bash
   npm run client:install
   ```

2. **Run the signaling server**

   ```bash
   npm start
   ```

   The server listens on [http://localhost:3000](http://localhost:3000) and exposes a `/ws` WebSocket endpoint for signaling.

3. **In a second terminal, start the Vite dev server**

   ```bash
   cd client
   npm run dev
   ```

   The React dev server runs on [http://localhost:5173](http://localhost:5173). API/WebSocket calls to `/ws` are proxied to the Node server, so both tabs can be opened locally for testing.

## Building for production

Generate the optimized React bundle and serve it from the Node server:

```bash
npm run build
npm start
```

The first command compiles the React client into `client/dist/`. When `npm start` runs afterwards, static assets are served directly from that folder. If the server does not find a build it returns a helper page explaining how to create one.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port for the Node.js server. |
| `VITE_SIGNALING_URL` | Derived from window location | Allows the React client (during build/dev) to connect to a remote WebSocket signaling endpoint such as a hosted instance. |
| `VITE_SIGNALING_PATH` | `/ws` | Overrides the WebSocket path segment when the URL is inferred from the browser location. |
| `VITE_SIGNALING_PROXY` | `http://localhost:3000` | Used only in development. Vite proxies `/ws` traffic to this origin. |

For example, when the backend runs on a different host you can build the client with:

```bash
cd client
VITE_SIGNALING_URL=wss://your-domain.example/ws npm run build
```

## Deployment on DigitalOcean

Below is a tested flow for hosting the project on a DigitalOcean Droplet using Ubuntu:

1. **Create a Droplet**
   - Choose the latest Ubuntu LTS image.
   - Select a plan (the $6/month Basic droplet is sufficient for testing).
   - Add your SSH key and create the droplet.

2. **Harden the droplet**
   - SSH in: `ssh root@your-droplet-ip`
   - Update the OS: `apt update && apt upgrade -y`
   - Install the UFW firewall, allow SSH (already open), HTTP, and HTTPS:
     ```bash
     ufw allow OpenSSH
     ufw allow 80
     ufw allow 443
     ufw enable
     ```

3. **Install runtime dependencies**
   ```bash
   apt install -y curl build-essential
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs git
   ```

4. **Clone and configure the project**
   ```bash
   git clone https://github.com/<your-account>/WebRTC.git
   cd WebRTC
   npm run client:install
   npm run build
   ```
   If the signaling server will live on a different hostname or behind TLS termination, set `VITE_SIGNALING_URL` before `npm run build`.

5. **Run the signaling server under a process manager**
   - Install PM2 (or another supervisor):
     ```bash
     npm install -g pm2
     ```
   - Start the server and persist it across reboots:
     ```bash
     pm2 start server.js --name webrtc-server
     pm2 save
     pm2 startup systemd
     ```

6. **(Optional) Add a reverse proxy and TLS**
   - Install Nginx: `apt install -y nginx`
   - Configure a server block that proxies HTTP and WebSocket requests to `http://127.0.0.1:3000`.
   - Use [Certbot](https://certbot.eff.org/) to obtain a free TLS certificate:
     ```bash
     apt install -y certbot python3-certbot-nginx
     certbot --nginx -d your-domain.example
     ```

7. **Verify**
   - Visit your domain (or droplet IP) in two different browsers or devices.
   - Create a room from one instance, join with the code from the other, and confirm video and audio streams flow.

## Troubleshooting tips

- If the page shows “Client build not found”, ensure you executed `npm run build` after installing client dependencies.
- When hosting the client separately from the signaling server, double-check the `VITE_SIGNALING_URL` that the client was built with and confirm the WebSocket endpoint is reachable (port open, TLS certificate valid, etc.).
- WebRTC requires direct media connectivity. If peers cannot connect behind restrictive NATs, consider configuring a TURN server such as [coturn](https://github.com/coturn/coturn) and add it to the `iceServers` array in `client/src/App.jsx` and on the server if you introduce authentication.

## License

MIT
