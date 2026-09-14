# Quiet Chess

A small, static chess PWA. No build step, account, or application database.

## Play

- **Computer:** three difficulties, local autosave/resume, paired undo, PGN download. AI runs in a Web Worker. Works offline after the first successful online load.
- **A friend:** select A friend → Create invite link → send the link. Host plays White, first guest plays Black. Legal moves and turn order are checked on both browsers. The guest's board is flipped automatically.
- Keyboard: Tab onto the board, arrow keys to navigate, Enter/Space to select or move, Escape to clear selection/cancel promotion.
- Install through the browser's install action; on iOS use Share → Add to Home Screen.

## Friend mode limitations and privacy

GitHub Pages serves the files; it does not run multiplayer servers. PeerJS 1.5.5 uses its public signaling service and default ICE/STUN/TURN configuration to establish a WebRTC data channel. These external services see connection metadata; peers may learn each other's network addresses. No audio/video permissions are requested. Anyone with the unguessable invite link can take the guest seat; this is not identity authentication or an anti-cheat system.

Keep both tabs open. Friend games are live-only: refresh, disconnect, or closing a tab requires a **new invite and new game**. Download PGN before leaving. There are no accounts, saved online rooms, automatic reconnect, ratings, or matchmaking. Restricted networks and public-service outages may prevent a connection; the app reports failure rather than silently allowing unsynchronized play. Owned signaling/TURN and server-side room persistence are the next step if this trial needs production reliability.

Computer games are saved only in this browser under `quiet-chess-v1`. Friend games never overwrite that save.

## Run locally

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Open `http://127.0.0.1:8766/`. HTTPS or localhost is required for PWA and invite features.

## Verify

With Puppeteer available and a Chromium-compatible browser:

```sh
PUPPETEER_PATH=/path/to/puppeteer \
CHROME_PATH=/path/to/chrome \
node smoke-test.cjs http://127.0.0.1:8766/
```

The check uses isolated browser contexts and actual public PeerJS signaling. It tests AI, keyboard play, undo, reload restoration, mobile overflow, offline AI, invitation joining, turn gating, board orientation, move synchronization, and disconnect handling. It requires internet access for the friend-mode section. A successful same-machine test does not prove connectivity between every network pair.

## Publish and update

GitHub Pages serves `main` at the repository root. No build needed. Bump `CACHE` in `sw.js` whenever changing cached assets. The new service worker waits until existing app tabs close, so it never replaces code during a live game. Close all app tabs and reopen to receive an update.

## Sources

`chess-benchmark-0.0.3.html` is the original artifact, retained unchanged. Its embedded WASM engine and piece font were extracted into `engine.js` and `pieces.woff2`; original engine source/build files were not supplied. No new license claim is made over those assets. PeerJS is vendored locally for reproducibility; its MIT license is in `PEERJS-LICENSE`.
