# KusuriLens Gemini backend

This local server keeps the Gemini API key out of the Expo app and exposes the product-photo endpoint used by `App.tsx`.

## Setup

1. Create or update `server/.env`:

```env
GEMINI_API_KEY=your-gemini-api-key-here
GEMINI_MODEL=gemini-2.5-flash
HOST=127.0.0.1
PORT=8787
# Optional. If set, enter the same token in the app's Backend connection settings.
KUSURILENS_API_TOKEN=make-a-long-random-token
```

2. Start the backend:

```powershell
npm run ai-server
```

3. Confirm the server is reachable:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

4. Confirm the Gemini API key and model work:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/test-gemini
```

## Expo on Android

The app defaults to `http://127.0.0.1:8787`. If you are testing on an Android device or emulator through ADB, run:

```powershell
adb reverse tcp:8787 tcp:8787
```

That makes `127.0.0.1:8787` inside the app reach this computer's local backend.

## Outside your LAN

Do not expose the raw Node port directly to the internet. For a Raspberry Pi deployment, prefer one of:

- Tailscale/WireGuard VPN: set the app API base URL to `http://PI_TAILSCALE_IP:8787`.
- Cloudflare Tunnel or a reverse proxy with HTTPS: set the app API base URL to `https://your-domain.example`.

If you set `KUSURILENS_API_TOKEN`, the mobile app must send the same token from Settings -> Backend connection.
