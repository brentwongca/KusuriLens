# KusuriLens Gemini backend

This local server keeps the Gemini API key out of the Expo app and exposes the product-photo endpoint used by `App.tsx`.

## Setup

1. Create or update `server/.env`:

```env
GEMINI_API_KEY=your-gemini-api-key-here
GEMINI_MODEL=gemini-2.5-flash
HOST=127.0.0.1
PORT=8788
```

2. Start the backend:

```powershell
npm run ai-server
```

3. Confirm the server is reachable:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
```

4. Confirm the Gemini API key and model work:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/test-gemini
```

## Expo on Android

The app calls `http://127.0.0.1:8788/analyze-product-photo`. If you are testing on an Android device or emulator through ADB, run:

```powershell
adb reverse tcp:8788 tcp:8788
```

That makes `127.0.0.1:8788` inside the app reach this computer's local backend.
