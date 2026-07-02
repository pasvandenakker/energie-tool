// p1-push-bridge.js — draait op de thuis-PC (zelfde netwerk als de HomeWizard P1-meter).
// Leest elke N seconden de lokale meter en pusht de meting naar de VPS-tool.
// Nodig omdat de VPS de meter zelf niet kan bereiken (privé thuisnetwerk achter NAT).
// Config met secrets staat in p1-push.config.json (staat in .gitignore, niet in git).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'p1-push.config.json'), 'utf8'));
const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
const target = new URL(cfg.vpsUrl);
const interval = cfg.intervalMs || 10000;

let ok = 0, fail = 0, lastErr = null;

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function fault(msg) {
  fail++;
  if (msg !== lastErr) { console.error(`${ts()}  ! ${msg}`); lastErr = msg; }
}

function readMeter() {
  const req = http.get(`http://${cfg.p1Ip}/api/v1/data`, { timeout: 5000 }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { push(JSON.parse(d)); } catch (e) { fault('meter parse: ' + e.message); } });
  });
  req.on('error', e => fault('meter onbereikbaar: ' + e.message));
  req.on('timeout', () => { req.destroy(); fault('meter timeout'); });
}

function push(data) {
  const body = JSON.stringify(data);
  const req = https.request({
    hostname: target.hostname,
    path: target.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': auth,
      'X-Push-Token': cfg.pushToken,
    },
    timeout: 10000,
  }, (res) => {
    res.resume();
    if (res.statusCode === 200) { ok++; lastErr = null; }
    else fault('push HTTP ' + res.statusCode);
  });
  req.on('error', e => fault('push: ' + e.message));
  req.on('timeout', () => { req.destroy(); fault('push timeout'); });
  req.write(body);
  req.end();
}

console.log(`${ts()}  P1 push-brug gestart: ${cfg.p1Ip} -> ${target.host} (elke ${interval / 1000}s)`);
readMeter();
setInterval(readMeter, interval);
setInterval(() => { console.log(`${ts()}  heartbeat — ok:${ok} fail:${fail}`); ok = 0; fail = 0; }, 300000);
