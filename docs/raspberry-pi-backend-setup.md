# KusuriLens Raspberry Pi Backend Setup

This guide deploys the KusuriLens backend on a Raspberry Pi while keeping AI API keys off the mobile app.

## Recommended Access Pattern

Use one of these patterns:

1. Tailscale VPN, easiest and safest for personal use.
   - Mobile app API URL: `http://PI_TAILSCALE_IP:8787`
   - Pi server host: `0.0.0.0`
   - Public internet exposure: none

2. Cloudflare Tunnel or HTTPS reverse proxy, best if you want a domain.
   - Mobile app API URL: `https://api.your-domain.com`
   - Pi server host: `127.0.0.1`
   - Public internet exposure: HTTPS tunnel/proxy only

Avoid exposing `http://YOUR_PUBLIC_IP:8787` directly to the internet.

## 1. Prepare The Pi

On the Raspberry Pi:

```bash
sudo apt update
sudo apt install -y git curl
```

Install Node.js LTS. If `node -v` already shows a recent LTS version, you can keep it.

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. Copy The Project To The Pi

Clone or copy this repo to the Pi:

```bash
mkdir -p ~/apps
cd ~/apps
git clone YOUR_REPO_URL KusuriLens
cd KusuriLens
npm ci
```

If you are copying manually from Windows instead of using Git, copy the project folder but do not copy `node_modules`; run `npm ci` on the Pi.

## 3. Create Backend Environment File

Create `server/.env`:

```bash
nano server/.env
```

For Tailscale/LAN access:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
HOST=0.0.0.0
PORT=8787
KUSURILENS_API_TOKEN=make-a-long-random-token
```

For Cloudflare Tunnel, Caddy, or Nginx reverse proxy:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
HOST=127.0.0.1
PORT=8787
KUSURILENS_API_TOKEN=make-a-long-random-token
```

Optional OpenRouter settings:

```env
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=google/gemma-4-31b-it:free
```

Generate a random token:

```bash
openssl rand -hex 32
```

Enter the same token in the mobile app under Settings -> Backend connection -> Access token.

## 4. Test The Backend Manually

Start the server:

```bash
npm run ai-server
```

In another terminal on the Pi:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8787/health
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8787/test-ai
```

Stop the manual server with `Ctrl+C` after it works.

## 5. Run It As A systemd Service

Create a service:

```bash
sudo nano /etc/systemd/system/kusurilens-backend.service
```

Paste this, replacing `YOUR_PI_USER` if needed:

```ini
[Unit]
Description=KusuriLens backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_PI_USER
WorkingDirectory=/home/YOUR_PI_USER/apps/KusuriLens
ExecStart=/usr/bin/npm run ai-server
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable kusurilens-backend
sudo systemctl start kusurilens-backend
sudo systemctl status kusurilens-backend
```

View logs:

```bash
journalctl -u kusurilens-backend -f
```

## 6. Connect From The Mobile App

Open KusuriLens on the phone:

1. Go to Settings.
2. Open Backend connection.
3. Set API base URL.
4. Set Access token to the value of `KUSURILENS_API_TOKEN`.
5. Tap Save and test.

Use one of these API base URLs:

```text
Local Windows development with adb reverse:
http://127.0.0.1:8787

Phone and Pi on the same Wi-Fi:
http://PI_LAN_IP:8787

Tailscale from anywhere:
http://PI_TAILSCALE_IP:8787

Cloudflare Tunnel / HTTPS domain:
https://api.your-domain.com
```

Find the Pi LAN IP:

```bash
hostname -I
```

## 7. Tailscale Option

Install Tailscale on the Pi and your phone, log both devices into the same Tailnet, then use the Pi Tailscale IP in the app.

On the Pi:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

Use:

```text
http://PI_TAILSCALE_IP:8787
```

For this mode, keep `HOST=0.0.0.0` in `server/.env`.

## 8. Cloudflare Tunnel Option

Use this when you want a public HTTPS domain without opening router ports.

High-level setup:

1. Add a domain to Cloudflare.
2. Install `cloudflared` on the Pi.
3. Create a tunnel that forwards `https://api.your-domain.com` to `http://127.0.0.1:8787`.
4. Keep `HOST=127.0.0.1` in `server/.env`.
5. Put `https://api.your-domain.com` into the mobile app.

The backend token is still required. HTTPS protects traffic in transit; the bearer token protects the endpoint from casual misuse.

## 9. Router Port Forwarding, Not Recommended

If you must expose the Pi directly:

1. Use HTTPS through Caddy or Nginx.
2. Do not expose raw port `8787`.
3. Keep `KUSURILENS_API_TOKEN` enabled.
4. Add firewall rules and rate limiting.

Direct public HTTP is not suitable for this app because requests may include product photos and the endpoint can spend AI API quota.

## 10. Release Checklist

- `server/.env` exists only on the Pi and is not committed.
- `GEMINI_API_KEY` or `OPENROUTER_API_KEY` works from `/test-ai`.
- `KUSURILENS_API_TOKEN` is set.
- The mobile app has the matching access token.
- The mobile app API base URL uses Tailscale or HTTPS when outside your LAN.
- `npm run typecheck` passes before building the app.
- The Pi service restarts after reboot.

