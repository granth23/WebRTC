# WebRTC Support Sessions

This project demonstrates a lightweight WebRTC workflow tailored for a support scenario. Customers open the **user** site, enter their name, and wait in a queue. Employees open the **employee** site, see everyone waiting, and connect to an individual customer. A standalone Node.js server (`server.js`) coordinates signaling between peers over a raw WebSocket implementation.

## Project structure

```
├── employee/             # Employee-facing Vite + React application
│   ├── index.html
│   ├── package.json
│   ├── server.js         # Static file server for production builds (port 4001)
│   └── src/
├── user/                 # Customer-facing Vite + React application
│   ├── index.html
│   ├── package.json
│   ├── server.js         # Static file server for production builds (port 4000)
│   └── src/
├── server.js             # HTTP + WebSocket signaling server (no external deps)
├── package.json          # Root scripts to manage all services
└── .gitignore
```

## Requirements

- Node.js 18 or newer
- Modern browser with camera & microphone permissions granted (the customer UI performs OCR in-browser via `tesseract.js`)

## Local development

1. **Install UI dependencies**

   ```bash
   npm run user:install
   npm run employee:install
   ```

   The signaling server itself uses only Node.js built-ins, so no additional install step is required at the root.

2. **Start the signaling server**

   ```bash
   npm start
   ```

   The server listens on [http://localhost:3000](http://localhost:3000) and exposes a `/ws` WebSocket endpoint.

3. **Launch the customer UI**

   ```bash
   npm run user:dev
   ```

   The Vite dev server runs on [http://localhost:4173](http://localhost:4173) and proxies `/ws` traffic to the signaling server.

4. **Launch the employee UI**

   ```bash
   npm run employee:dev
   ```

   This dev server runs on [http://localhost:4174](http://localhost:4174) and proxies signaling requests the same way.

With all three processes running, open the user site in one browser tab, enter a name, and press **Start session**. The name instantly appears in the employee queue. When an employee selects a customer, the signaling server notifies both parties and the WebRTC session begins. Uploading a PAN card image will trigger on-device OCR to populate the verification fields automatically.

## Building for production

The root `build` script compiles both front-ends:

```bash
npm run build
```

Afterwards each UI can be served by its dedicated Node.js server:

```bash
npm run user:start      # Serves user/dist on port 4000 (override with PORT)
npm run employee:start  # Serves employee/dist on port 4001
npm start               # Runs the signaling server on port 3000
```

You can place these behind a reverse proxy or host them separately depending on your deployment needs. Each UI only needs access to the signaling server’s WebSocket endpoint. The customer UI bundles `tesseract.js`, so no additional backend service is required for OCR.

## Environment variables

| Variable | Default | Scope | Purpose |
| --- | --- | --- | --- |
| `PORT` | `3000` | Root `server.js` | Port for the WebSocket signaling server. |
| `VITE_SIGNALING_URL` | Derived from browser location | User + Employee apps | Override the full WebSocket URL when building for a remote signaling host. |
| `VITE_SIGNALING_PATH` | `/ws` | User + Employee apps | Customize the path segment appended to the inferred signaling URL. |
| `VITE_SIGNALING_PROXY` | `http://localhost:3000` | User + Employee dev servers | Proxy target for `/ws` traffic during development. |

Each Vite app respects the same environment variables, so you can point both interfaces at a hosted signaling server when building for production:

```bash
cd user
VITE_SIGNALING_URL=wss://signaling.example/ws npm run build
cd ../employee
VITE_SIGNALING_URL=wss://signaling.example/ws npm run build
```

## How it works

- **User flow:** a customer provides their display name, the server registers a dedicated room, and the name is broadcast to all connected employees. The user waits for an employee to join.
- **Employee flow:** the employee UI maintains a live list of waiting customers. Selecting one sends a `join` request, the signaling server pairs the two participants, and standard WebRTC offer/answer negotiation begins.
- **Session lifecycle:** if an employee leaves, the user automatically re-enters the queue. When the user leaves, the associated room is torn down.
- **PAN extraction:** when the customer uploads the front of their PAN card, the UI runs on-device OCR with `tesseract.js` to auto-fill the PAN number, name, father's name, and date of birth.

## Deployment notes

1. Provision your infrastructure (e.g., a VM or container host) and install Node.js 18+.
2. Clone this repository and build both UIs with `npm run build`.
3. Run the three services under a process manager of your choice (PM2, systemd, Docker, etc.).
4. Optionally place the three HTTP endpoints behind a reverse proxy or consolidate them behind a single domain with separate subpaths/ports.

Because the signaling server does not serve the UI directly, you are free to host the user and employee apps wherever you prefer, as long as they can reach the WebSocket endpoint.

## License

MIT
