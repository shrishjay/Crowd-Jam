'use strict';
// Picks the address phones can actually reach. On Windows laptops the first non-loopback IPv4 is often a VPN / VMware /
// Hyper-V / WSL adapter that phones cannot reach, which makes a QR code that opens nothing. Rank candidates instead.
const os = require('os');

const VIRTUAL = /vethernet|vmware|virtualbox|vbox|wsl|docker|hyper-v|openvpn|tap-|tailscale|zerotier|hamachi|loopback|bluetooth|vpn|tun\d/i;

function candidates(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces)) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue; // link-local = no real network
    let score = 0;
    if (VIRTUAL.test(name)) score -= 100;
    if (/wi-?fi|wlan|wireless|^en\d|^eth|ethernet/i.test(name) && !VIRTUAL.test(name)) score += 30;
    if (i.address.startsWith('192.168.')) score += 20; else if (i.address.startsWith('10.')) score += 10; else if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) score += 5;
    out.push({ name, ip: i.address, score, virtual: VIRTUAL.test(name) });
  }
  return out.sort((a, b) => b.score - a.score);
}

module.exports = { candidates, VIRTUAL };
