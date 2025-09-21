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
│   ├── pan_server.py     # Flask service for PAN OCR + metadata extraction (port 5000)
│   ├── requirements.txt  # Python dependencies for the PAN service
│   └── src/
├── server.js             # HTTP + WebSocket signaling server (no external deps)
├── package.json          # Root scripts to manage all services
└── .gitignore
```

## Requirements

- Node.js 18 or newer
- Python 3.10 or newer (for the PAN extraction microservice)
- Modern browser with camera & microphone permissions granted

## Local development

1. **Install UI dependencies**

   ```bash
   npm run user:install
   npm run employee:install
   ```

   The signaling server itself uses only Node.js built-ins, so no additional install step is required at the root.

2. **Install PAN extraction dependencies**

   ```bash
   python3 -m pip install -r user/requirements.txt
   ```

   Using a virtual environment is recommended but optional for local development. Install the [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) binary if you want real image extraction; otherwise the service falls back to best-effort text parsing.

3. **Start the signaling server**

   ```bash
   npm start
   ```

   The server listens on [http://localhost:3000](http://localhost:3000) and exposes a `/ws` WebSocket endpoint.

4. **Start the PAN extraction server**

   ```bash
   npm run user:pan
   ```

   The Flask service listens on [http://localhost:5000](http://localhost:5000) and exposes `/api/pan/extract`.

5. **Launch the customer UI**

   ```bash
   npm run user:dev
   ```

   The Vite dev server runs on [http://localhost:4173](http://localhost:4173) and proxies `/ws` traffic to the signaling server.

6. **Launch the employee UI**

   ```bash
   npm run employee:dev
   ```

   This dev server runs on [http://localhost:4174](http://localhost:4174) and proxies signaling requests the same way.

With all three processes running, open the user site in one browser tab, enter a name, and press **Start session**. The name instantly appears in the employee queue. When an employee selects a customer, the signaling server notifies both parties and the WebRTC session begins.

## Building for production

The root `build` script compiles both front-ends:

```bash
npm run build
```

Afterwards each UI can be served by its dedicated Node.js server, and the PAN extraction API can run alongside them:

```bash
npm run user:start      # Serves user/dist on port 4000 (override with PORT)
npm run employee:start  # Serves employee/dist on port 4001
npm start               # Runs the signaling server on port 3000
npm run user:pan        # Starts the Flask PAN service on port 5000
```

You can place these behind a reverse proxy or host them separately depending on your deployment needs. Each UI only needs access to the signaling server’s WebSocket endpoint.

## Environment variables

| Variable | Default | Scope | Purpose |
| --- | --- | --- | --- |
| `PORT` | `3000` | Root `server.js` | Port for the WebSocket signaling server. |
| `VITE_SIGNALING_URL` | Derived from browser location | User + Employee apps | Override the full WebSocket URL when building for a remote signaling host. |
| `VITE_SIGNALING_PATH` | `/ws` | User + Employee apps | Customize the path segment appended to the inferred signaling URL. |
| `VITE_SIGNALING_PROXY` | `http://localhost:3000` | User + Employee dev servers | Proxy target for `/ws` traffic during development. |
| `VITE_PAN_EXTRACTION_URL` | `http://localhost:5000/api/pan/extract` | User app | HTTP endpoint for the Flask PAN extraction API. |
| `PAN_SERVER_PORT` | `5000` | `user/pan_server.py` | Port where the Flask service listens. |

Each Vite app respects the same environment variables, so you can point both interfaces at a hosted signaling server when building for production:

```bash
cd user
VITE_SIGNALING_URL=wss://signaling.example/ws \
VITE_PAN_EXTRACTION_URL=https://loans.example/api/pan/extract \
  npm run build
cd ../employee
VITE_SIGNALING_URL=wss://signaling.example/ws npm run build
```

## How it works

- **User flow:** a customer provides their display name, the server registers a dedicated room, and the name is broadcast to all connected employees. The user waits for an employee to join.
- **Employee flow:** the employee UI maintains a live list of waiting customers. Selecting one sends a `join` request, the signaling server pairs the two participants, and standard WebRTC offer/answer negotiation begins.
- **Session lifecycle:** if an employee leaves, the user automatically re-enters the queue. When the user leaves, the associated room is torn down.
- **PAN extraction service:** when the customer uploads the front of their PAN card, the Flask API attempts OCR (falling back to simple text parsing) to auto-fill the PAN number, name, father's name, and date of birth.

## Deployment notes

1. Provision your infrastructure (e.g., a VM or container host) and install Node.js 18+.
2. Clone this repository and build both UIs with `npm run build`.
3. Run the three services under a process manager of your choice (PM2, systemd, Docker, etc.).
4. Optionally place the three HTTP endpoints behind a reverse proxy or consolidate them behind a single domain with separate subpaths/ports.

Because the signaling server does not serve the UI directly, you are free to host the user and employee apps wherever you prefer, as long as they can reach the WebSocket endpoint.

## License

MIT
