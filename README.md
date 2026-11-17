# CrowdSynth

A crowd-powered generative orchestra. Phones send gestures; a deterministic music engine turns them into music in one key, on one grid; the host plays it and exports a WAV. Implements `PROJECT_BLUEPRINT.md`.

```
Phones (browser) --gestures--> Server (validate, rate-limit, roles, conductor) --timestamped musical events--> Host (WebAudio clock, synth, WAV export)
```

## Run (laptop = server + host screen)
```
npm install
npm start                 # prints every address; the first listed is the one phones should use
npm test                  # 14 tests: engine, protocol, full server slice
npm run load              # 30 simulated phones + abuse burst
```
1. Open `http://localhost:3000`, click **Create session** (this also unlocks audio), pick a mood, **Start**. Start works with zero phones (autonomous demo).
2. Phones scan the QR (same Wi-Fi). Tap and hold anywhere on the big pad. Shake is optional.
3. The piece moves Rhythm, Foundation, Melody, Finale on its own (or press **Next round**), ends with a cadence, then renders a WAV you can play and save.

**Phone shows nothing / cannot connect?** The QR uses the server's best LAN address, but laptops often have VPN/VMware/Hyper-V adapters. Pick the right one in the **Address** dropdown on the host page. Venue Wi-Fi often isolates devices: use a phone hotspot. On Windows allow inbound TCP 3000 (admin terminal): `netsh advfirewall firewall add rule name=CrowdSynth dir=in action=allow protocol=TCP localport=3000`.

## Android host
`android/` is a thin native shell: a WebView that loads the host page from the server and a bridge that saves the WAV to Downloads. Open the folder in Android Studio, run it on the phone, enter `http://<laptop-ip>:3000`. (Not built or tested here: no Android SDK on the dev machine.) The same host page works in desktop or Android Chrome.

## What keeps it musical (server/)
- `theory.js` scales, diatonic chords, voice leading, seeded PRNG, quantisation. Three presets (Radiant, Cinematic, Playful) with fixed progressions and V-I (or VII-i) cadences.
- `conductor.js` four rounds with min/max duration and bar-boundary transitions; role quotas (largest-remainder, rotated per round); contextual gesture-to-intent mapping; melody voice-leading score (chord tones on beats 1 and 3, stepwise motion, leap penalty); event merging; budgets (24 events/bar, 8 pitched voices, 6 drums/beat, 2 melody and 1 bass/beat); adaptive density; autonomous fallback for missing roles; deterministic ending with a final collective hit.
- `rooms.js` token-bucket rate limit (4 cap, 2/s, 8 per 2 s), duplicate and stale-sequence rejection, heartbeat expiry, bounded event log, pause/resume/end.
- Phones can only send `tap / hold_start / hold_update / hold_end / shake / tilt`. Never notes, frequencies or instruments.

## Layout
`server/` backend and music engine, `public/` host page + phone page + synth/renderer, `test/`, `android/` host shell.

## Honest limits
Single in-memory room process (rooms are lost on restart). Tap-to-sound latency is about 250-450 ms by design (quantised and scheduled ahead). The host audio could not be listened to in the dev environment, so tune the mix by ear on the real speakers. Motion sensors vary by browser and are optional.
