# Flow Cards

A swipe-through Anki reviewer you can add to your iPhone home screen. It reads your due cards from **AnkiConnect**, works offline, and writes every answer back to Anki's scheduler, so your progress stays in Anki.

| Gesture | Action |
|---|---|
| Tap, or swipe ↑ | Flip the card |
| Swipe ↑ | Good |
| Swipe → | Easy |
| Swipe ← | Again (the card comes back in a few cards) |
| Swipe ↓ | Hard |
| ↶ (top right) | Undo the last answer(s), up to ~12 s after each swipe |

As you drag, the card shows the grade and the next interval Anki would give it. A streak of correct answers builds a combo (×N), and bigger combos give bigger particle bursts. Every 10 in a row sets off confetti.

## All-day offline
Open the app once in the morning while the Mac is on, and it downloads the whole day's cards, including learning cards due later. After that you can review all day with the Mac closed. Cards you get wrong, and new or learning cards, come back later in the session the way Anki's learning steps would. Answers are kept on the phone and sent the next time Anki can be reached. Anki then schedules them as of that moment, so intervals can be off by about a day.

## How sync works

1. When it opens, the app asks AnkiConnect for today's due and new cards (within Anki's own daily limits), with images inlined. It caches them on the phone.
2. Each swipe is queued and sent with `answerCards`, which runs Anki's real scheduler, about a second later. If Anki can't be reached, answers wait in the queue and go up the next time it can.
3. After pushing answers, the app can also ask Anki desktop to sync with AnkiWeb, so AnkiMobile and AnkiDroid pick up the changes too.

The dot in the top left shows the state: green means synced, amber means answers are waiting, and grey means offline. Tap the dot to force a sync.

## Setup

### 1. AnkiConnect (on the Mac)
In Anki: Tools → Add-ons → AnkiConnect → Config. Make sure the GitHub Pages origin is allowed:

```json
"webCorsOriginList": ["http://localhost", "https://milo-griffiths.github.io"]
```

Anki has to be running for the phone to sync. Reviews you do while it's closed are kept on the phone and sent later.

### 2. Reach the Mac from the iPhone over HTTPS
The app is served over HTTPS, so iOS blocks it from calling a plain `http://192.168…` address. The simplest fix is [Tailscale](https://tailscale.com), which is free:

```bash
tailscale serve --bg 8765
```

This gives you a URL like `https://your-mac.tailXXXX.ts.net`. Install Tailscale on the iPhone too, then paste that URL into the app's settings (⚙︎). It works from anywhere, not just on home Wi-Fi.

If you ever expose the Mac beyond your own tailnet (for example with `tailscale funnel`), set an `apiKey` in the AnkiConnect config and enter the same key in the app.

### 3. Add to the home screen
Open `https://milo-griffiths.github.io/AddictiveFlashcards/` in Safari → Share → **Add to Home Screen**.

## Files
`index.html`, `style.css`, `app.js` (all the logic), `sw.js` (offline cache), `manifest.webmanifest`, and `icons/`. There's no build step.
