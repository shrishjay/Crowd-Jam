# Crowd Jam

Everyone in the room scans a QR code, gets an instrument, and taps. A "conductor" turns the chaos into one piece of music that plays from the host screen.

```
npm install && npm start     # open http://localhost:3000 on the laptop connected to the speakers, click Start
npm test                     # music-algorithm tests
```
Laptop and phones must be on the same Wi-Fi (conference Wi-Fi often isolates clients: use a phone hotspot). Set `BASE_URL=http://<ip>:3000` if the auto-detected IP is wrong.

## Why it sounds musical (`public/music.js`)
- **Shared grid**: taps are quantized to 16th notes at 100 BPM; each instrument only sounds on steps where it makes sense (kick on beats, snare on the backbeat).
- **Key lock**: A minor pentatonic over Am-F-C-G. No wrong notes exist.
- **Chord snap**: on strong beats melody notes snap to the current chord's tones. Bass plays root/fifth/octave of the current chord.
- **Crowd consensus**: all melody phones vote; the median wins, so 30 people produce one line, louder with more voters.
- **Leap limit**: melody can move at most 3 scale steps at a time, so it sings rather than jumps.
- **Rate limits**: 4 taps/s per phone, max one melody note per 8th, one arp note per 16th, so a spammer can't make noise.
- **Roles**: phones are assigned lead, bass, chords, arp or drums round-robin, so the crowd forms a band.
- **Arc**: Intro, Groove, Peak, then an E to Am cadence with a held final chord (about 96 s). "Replay" plays back exactly what was made.

## Phones
The phone client is a web page (`play.html`), so it works on Android in Chrome with nothing to install. For a real APK, wrap that URL in a WebView.
