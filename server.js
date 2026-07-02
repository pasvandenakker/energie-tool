const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ZonneplanAPI = require('./zonneplan-api');
const EnergyZeroApi = require('./energyzero-api');

const app = express();

// Genereer sessie secret voor token opslag
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'p1-config.json');
const DB_PATH = path.join(__dirname, 'p1-data.json');
const P1_MODE = process.env.P1_MODE || 'poll';        // 'poll' = tool leest zelf de lokale meter; 'push' = data komt binnen via /api/p1/push
const P1_PUSH_TOKEN = process.env.P1_PUSH_TOKEN || ''; // gedeeld geheim voor de push-brug (thuis-PC -> VPS)

// ===== CONFIG =====
let config = { p1Ip: 'p1meter.local', pollingInterval: 10000 };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
}

// ===== DATA STORE (JSON-based, geen native dependencies) =====
let readings = [];
if (fs.existsSync(DB_PATH)) {
  try { readings = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { readings = []; }
}
const MAX_READINGS = 20000; // ~55 uur bij 10s interval

function saveReadings() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(readings)); } catch {}
}

// ===== P1 METER POLLING =====
let lastReading = null;
let p1Connected = false;
let p1Error = null;
let pollTimer = null;

// Verwerk één P1-meting (van lokale poll óf van de push-brug) naar lastReading + opslag
function ingestP1(parsed) {
  lastReading = {
    timestamp: Date.now(),
    totalPowerImportKwh: parsed.total_power_import_kwh,
    totalPowerExportKwh: parsed.total_power_export_kwh,
    activePowerW: parsed.active_power_w,
    activePowerL1W: parsed.active_power_l1_w,
    activePowerL2W: parsed.active_power_l2_w,
    activePowerL3W: parsed.active_power_l3_w,
    totalGasM3: parsed.total_gas_m3,
    activeTariff: parsed.active_tariff,
    wifiStrength: parsed.wifi_strength,
    smrVersion: parsed.smr_version,
    meterModel: parsed.meter_model,
    uniqueId: parsed.unique_id
  };
  p1Connected = true;
  p1Error = null;
  readings.push(lastReading);
  if (readings.length > MAX_READINGS) readings.splice(0, readings.length - MAX_READINGS);
  saveReadings();
}

function fetchP1() {
  const url = `http://${config.p1Ip}/api/v1/data`;
  const req = http.get(url, { timeout: 5000 }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { ingestP1(JSON.parse(data)); }
      catch (e) { p1Error = 'Parse fout: ' + e.message; }
    });
  });
  req.on('error', (e) => { p1Connected = false; p1Error = e.message; });
  req.on('timeout', () => { req.destroy(); p1Error = 'Timeout'; });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchP1();
  pollTimer = setInterval(fetchP1, config.pollingInterval);
}

if (P1_MODE !== 'push') startPolling();

// ===== OPNIEUW PROBEREN ANDERE IPs =====
function scanP1Addresses() {
  const candidates = [
    config.p1Ip,
    'p1meter.local',
    '192.168.1.242',
    '192.168.2.242',
    '192.168.0.242',
    '192.168.1.243',
    '192.168.2.243',
    '192.168.0.243',
  ];

  let tried = 0;
  candidates.forEach(ip => {
    const url = `http://${ip}/api/v1/`;
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.smr_version) {
            console.log(`✓ P1 meter gevonden op ${ip}`);
            config.p1Ip = ip;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
            p1Connected = true;
            p1Error = null;
            fetchP1();
          }
        } catch {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  });
}

if (P1_MODE !== 'push') setTimeout(scanP1Addresses, 5000);

// ===== HELPER: zon-opwek schatten =====
function estimateSolarPower() {
  if (!lastReading) return null;
  const netto = lastReading.activePowerW;
  // Als netto negatief is (export > import), dan is er zon-opwek
  // We kunnen niet exact weten wat panelen opwekken zonder aparte meter,
  // maar we schatten: opwek = abs(netto) als export, anders 0
  // Alleen bruikbaar als we weten dat er panelen zijn
  if (netto < 0) return Math.abs(netto);
  return 0;
}

// ===== API ROUTES =====
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/status', (req, res) => {
  res.json({
    server: 'EnergieSim v1.0',
    p1Connected,
    p1Ip: config.p1Ip,
    p1Error,
    pollingInterval: config.pollingInterval,
    readingsCount: readings.length,
    lastReading: lastReading ? {
      ...lastReading,
      age: Date.now() - lastReading.timestamp
    } : null,
    readingSince: readings.length > 0 ? new Date(readings[0].timestamp).toISOString() : null,
    readingUntil: readings.length > 0 ? new Date(readings[readings.length - 1].timestamp).toISOString() : null,
  });
});

app.get('/api/live', (req, res) => {
  if (!lastReading || !p1Connected) {
    return res.json({ connected: false, error: p1Error || 'Geen data van P1 meter', lastReading });
  }
  res.json({
    connected: true,
    current: {
      powerW: lastReading.activePowerW,
      powerL1W: lastReading.activePowerL1W,
      powerL2W: lastReading.activePowerL2W,
      powerL3W: lastReading.activePowerL3W,
      importTotalKwh: lastReading.totalPowerImportKwh,
      exportTotalKwh: lastReading.totalPowerExportKwh,
      gasTotalM3: lastReading.totalGasM3,
      solarEstimateW: estimateSolarPower(),
      tariff: lastReading.activeTariff,
      timestamp: lastReading.timestamp,
      age: Date.now() - lastReading.timestamp
    },
    meterInfo: {
      model: lastReading.meterModel,
      smrVersion: lastReading.smrVersion,
      wifiStrength: lastReading.wifiStrength,
    }
  });
});

app.get('/api/history', (req, res) => {
  const hours = parseFloat(req.query.hours) || 24;
  const since = Date.now() - hours * 3600 * 1000;
  const filtered = readings.filter(r => r.timestamp >= since);
  res.json({
    hours,
    points: filtered.length,
    from: filtered.length > 0 ? new Date(filtered[0].timestamp).toISOString() : null,
    to: filtered.length > 0 ? new Date(filtered[filtered.length - 1].timestamp).toISOString() : null,
    data: filtered.map(r => ({
      t: r.timestamp,
      p: r.activePowerW,
      p1: r.activePowerL1W,
      p2: r.activePowerL2W,
      p3: r.activePowerL3W,
      im: r.totalPowerImportKwh,
      ex: r.totalPowerExportKwh
    }))
  });
});

app.post('/api/config', (req, res) => {
  if (req.body.p1Ip) config.p1Ip = req.body.p1Ip;
  if (req.body.pollingInterval) config.pollingInterval = req.body.pollingInterval;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  if (P1_MODE !== 'push') startPolling();
  res.json({ success: true, config });
});

// Push-brug: thuis-PC leest de lokale HomeWizard en POST de rauwe /api/v1/data hierheen
app.post('/api/p1/push', (req, res) => {
  if (P1_PUSH_TOKEN && req.headers['x-push-token'] !== P1_PUSH_TOKEN) {
    return res.status(403).json({ error: 'Ongeldige push-token' });
  }
  if (!req.body || typeof req.body.active_power_w === 'undefined') {
    return res.status(400).json({ error: 'Geen geldige P1-data' });
  }
  ingestP1(req.body);
  res.json({ success: true, readings: readings.length });
});

app.get('/api/dashboard', (req, res) => {
  // Geef een samenvatting die de frontend gebruikt om de rekenmodule te voeden
  if (!lastReading || readings.length < 2) {
    return res.json({ available: false });
  }

  const first = readings[0];
  const last = readings[readings.length - 1];
  const elapsedH = (last.timestamp - first.timestamp) / 3600000;

  if (elapsedH < 1) {
    return res.json({ available: false, message: 'Nog niet genoeg data (minimaal 1 uur)' });
  }

  const totalKwh = last.totalPowerImportKwh - first.totalPowerImportKwh;
  const exportKwh = last.totalPowerExportKwh - first.totalPowerExportKwh;

  // Huidige vermogen als schatting voor jaarlijks
  const avgPowerW = readings.reduce((s, r) => s + r.activePowerW, 0) / readings.length;
  const projectedYearKwh = Math.abs(avgPowerW) * 8760 / 1000;

  res.json({
    available: true,
    measuredHours: elapsedH.toFixed(1),
    totalImportSinceStart: totalKwh,
    totalExportSinceStart: exportKwh,
    avgPowerW: Math.round(avgPowerW),
    projectedYearKwh: Math.round(projectedYearKwh),
    currentSolarEstimateW: estimateSolarPower(),
  });
});

// ===== MARKT DATA (vaste tarieven juni 2026) =====
const MARKT_DATA = {
  bijgewerkt: '30-06-2026',
  gemiddeldPrijsKwh: 0.260,
  gemiddeldPrijsGasM3: 1.399,
  energieBelastingKwh: 0.11084,

  leveranciers: [
    {
      naam: 'Budget Thuis',
      vast1jr: 0.263, vast3jr: 0.241, variabel: 0.267,
      tlv: 0.06, tlkosten: 0.04, bonus: 410,
      url: 'https://www.budgetthuis.nl',
    },
    {
      naam: 'Vattenfall',
      vast1jr: 0.249, vast3jr: null, variabel: 0.259,
      tlv: 0.05, tlkosten: 0.02, bonus: 400,
      url: 'https://www.vattenfall.nl',
    },
    {
      naam: 'Essent',
      vast1jr: 0.244, vast3jr: 0.255, variabel: 0.281,
      tlv: 0.06, tlkosten: 0.03, bonus: 330,
      url: 'https://www.essent.nl',
    },
    {
      naam: 'Eneco',
      vast1jr: 0.260, vast3jr: 0.246, variabel: 0.272,
      tlv: 0.06, tlkosten: 0.03, bonus: 350,
      url: 'https://www.eneco.nl',
    },
    {
      naam: 'Vandebron',
      vast1jr: 0.248, vast3jr: 0.236, variabel: 0.250,
      tlv: 0.04, tlkosten: 0.04, bonus: 400,
      url: 'https://www.vandebron.nl',
    },
    {
      naam: 'ENGIE',
      vast1jr: 0.257, vast3jr: 0.239, variabel: null,
      tlv: 0.05, tlkosten: 0.03, bonus: 420,
      url: 'https://www.engie.nl',
    },
    {
      naam: 'Energiedirect',
      vast1jr: 0.245, vast3jr: 0.233, variabel: null,
      tlv: 0.06, tlkosten: 0.04, bonus: 330,
      url: 'https://www.energiedirect.nl',
    },
    {
      naam: 'Greenchoice',
      vast1jr: 0.245, vast3jr: null, variabel: null,
      tlv: 0.05, tlkosten: 0.02, bonus: 350,
      url: 'https://www.greenchoice.nl',
    },
    {
      naam: 'UnitedConsumers',
      vast1jr: 0.252, vast3jr: 0.243, variabel: null,
      tlv: 0.06, tlkosten: 0.05, bonus: 460,
      url: 'https://www.unitedconsumers.nl',
    },
    {
      naam: 'Delta Energie',
      vast1jr: 0.262, vast3jr: 0.258, variabel: null,
      tlv: 0.05, tlkosten: 0.03, bonus: 215,
      url: 'https://www.deltaenergie.nl',
    },
  ],
};

// ===== ENERGYZERO API =====
const ez = new EnergyZeroApi();

app.get('/api/market/prices', async (req, res) => {
  try {
    const dynamic = await ez.getTodayAverage();
    const cheapestHours = await ez.getCheapestHours(12);
    res.json({
      bijgewerkt: MARKT_DATA.bijgewerkt,
      gemiddeld: MARKT_DATA.gemiddeldPrijsKwh,
      belasting: MARKT_DATA.energieBelastingKwh,
      dynamicToday: dynamic,
      cheapestHours,
      fixed: MARKT_DATA.leveranciers,
    });
  } catch (e) {
    // Fallback: stuur alleen marktdata zonder live prijzen
    res.json({
      bijgewerkt: MARKT_DATA.bijgewerkt,
      gemiddeld: MARKT_DATA.gemiddeldPrijsKwh,
      belasting: MARKT_DATA.energieBelastingKwh,
      dynamicToday: null,
      cheapestHours: null,
      error: e.message,
      fixed: MARKT_DATA.leveranciers,
    });
  }
});

app.get('/api/market/compare', async (req, res) => {
  // Vergelijk alle leveranciers met Zonneplan op basis van gebruikersprofiel
  // query params: verbruik (kWh), opwek (kWh), contractType
  const verbruik = parseFloat(req.query.verbruik) || 3500;
  const opwek = parseFloat(req.query.opwek) || 5000;
  const nettoVerbruik = Math.max(0, verbruik - opwek);
  const overschot = Math.max(0, opwek - verbruik);
  const salderingFractie = parseFloat(req.query.saldering) || 0.64;

  try {
    const dynamic = await ez.getTodayAverage();
    const dynamicAvgPrice = dynamic ? dynamic.avg : 0.24;

    // Zonneplan: dynamisch, gemiddelde inkoop = EPEX + opslag ~0,01
    const zonneplanInkoop = dynamicAvgPrice;
    const zonneplanTlv = dynamicAvgPrice * 0.8; // 80% van marktprijs

    const resultaten = [];

    // Zonneplan dynamisch
    const zpNetto = nettoVerbruik * zonneplanInkoop;
    const zpOverschotWaarde = overschot * salderingFractie * zonneplanInkoop + overschot * (1 - salderingFractie) * zonneplanTlv;
    const zpKosten = zpNetto - zpOverschotWaarde;
    resultaten.push({
      naam: 'Zonneplan (dynamisch)',
      type: 'Dynamisch',
      tariefKwh: zonneplanInkoop,
      tlv: zonneplanTlv,
      jaarkosten: Math.round(zpKosten),
      tovZonneplan: 0,
    });

    // Alle vaste leveranciers (1 jaar)
    for (const lev of MARKT_DATA.leveranciers) {
      if (!lev.vast1jr) continue;
      const nettoLev = nettoVerbruik * lev.vast1jr;
      const overschotWaardeLev = overschot * salderingFractie * lev.vast1jr + overschot * (1 - salderingFractie) * lev.tlv;
      const tlkosten = overschot * lev.tlkosten || 0;
      const bonus = lev.bonus || 0;
      let kostenLev = nettoLev - overschotWaardeLev + tlkosten - bonus;

      resultaten.push({
        naam: lev.naam + ' (1jr)',
        type: 'Vast 1jr',
        tariefKwh: lev.vast1jr,
        tlv: lev.tlv,
        tlkosten: lev.tlkosten || 0,
        bonus: bonus,
        jaarkosten: Math.round(kostenLev),
        tovZonneplan: Math.round(kostenLev - zpKosten),
      });
    }

    // Sorteer op jaarkosten
    resultaten.sort((a, b) => a.jaarkosten - b.jaarkosten);

    res.json({
      verbruik, opwek, nettoVerbruik, overschot, salderingFractie,
      dynamicAvgPrice: dynamicAvgPrice,
      dynamisch: dynamic ? { gemiddeld: dynamic.avg, min: dynamic.min, max: dynamic.max } : null,
      resultaten,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ZONNEPLAN API ROUTES =====
const zp = new ZonneplanAPI();

// Expose API instance voor hergebruik
app.set('zp', zp);

app.get('/api/zonneplan/status', (req, res) => {
  res.json({
    loggedIn: zp.isLoggedIn,
    canRefresh: zp.canRefresh,
    user: zp.userInfo ? {
      name: zp.userInfo.full_name || zp.userInfo.first_name,
      email: zp.userInfo.email,
    } : null,
    connectionUuid: zp.connectionUuid,
    connectionCount: zp.connectionUuid ? 1 : 0,
    contractTypes: zp.contracts.map(c => ({ label: c.label, type: c.type })),
  });
});

app.post('/api/zonneplan/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email verplicht' });

    const result = await zp.requestLogin(email);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/zonneplan/poll', async (req, res) => {
  try {
    const result = await zp.pollLogin();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/zonneplan/refresh', async (req, res) => {
  try {
    const ok = await zp.refreshAccessToken();
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/zonneplan/logout', (req, res) => {
  zp.accessToken = null;
  zp.refreshToken = null;
  zp.expiryDate = null;
  zp.connectionUuid = null;
  zp.userInfo = null;
  res.json({ success: true });
});

app.get('/api/zonneplan/summary', async (req, res) => {
  try {
    if (!zp.isLoggedIn) {
      if (zp.canRefresh) await zp.refreshAccessToken();
      else return res.status(401).json({ error: 'Niet ingelogd' });
    }
    const summary = await zp.getSummary();
    if (summary) {
      // Probeer ook huidige tarieven
      const currentTariff = summary.current_tariff_incl_vat / 100000; // Zonneplan gebruikt micro's
      const tlvEstimate = currentTariff * 0.4; // schat TLV op ~40% van inkoop

      res.json({
        success: true,
        totalDelivered: (summary.total_delivered || 0) / 1000,
        totalProduced: (summary.total_produced || 0) / 1000,
        currentTariff,
        currentTariffExVat: (summary.current_tariff_ex_vat || 0) / 100000,
        tariffGroup: summary.current_tariff_group,
        statusMsg: summary.status_message,
        statusTip: summary.status_tip,
        sustainabilityScore: summary.sustainability_score,
        p1Connected: summary.p1_reader?.connected,
        p1LastMeasurement: summary.p1_reader?.last_measurement,
        // Tarieven voor de tool
        estimatedTlv: tlvEstimate,
      });
    } else {
      res.json({ success: false, error: 'Geen data' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/zonneplan/history', async (req, res) => {
  try {
    if (!zp.isLoggedIn) return res.status(401).json({ error: 'Niet ingelogd' });

    const history = await zp.getFullHistory();
    const processed = zp.processMeasurementsToToolData(history.monthly);

    if (processed) {
      res.json({ success: true, ...processed, yearlyData: history.yearly });
    } else {
      res.json({ success: false, error: 'Geen historische data beschikbaar' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/zonneplan/import', async (req, res) => {
  // Importeer Zonneplan data in de tool
  try {
    if (!zp.isLoggedIn) return res.status(401).json({ error: 'Niet ingelogd' });

    // Haal summary en historie op
    const summary = await zp.getSummary();
    const history = await zp.getFullHistory();
    const processed = zp.processMeasurementsToToolData(history.monthly);

    if (!processed) {
      return res.json({ success: false, error: 'Geen historische data' });
    }

    // Tool-data klaarmaken
    const importData = {
      jaarVerbruik: Math.round(processed.totaalDeliveredKwh),
      jaarOpwek: Math.round(processed.totaalProducedKwh),
      maandCijfers: processed.maandCijfers,
      // Tarieven uit summary
      actueelTarief: summary ? summary.current_tariff_incl_vat / 100000 : null,
    };

    res.json({ success: true, ...importData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  const host = process.env.HOST || 'localhost';
  console.log(`\n  ⚡ EnergieSim v1.0`);
  console.log(`  📍 http://${host}:${PORT}`);
  console.log(`  📡 P1 meter: ${config.p1Ip} (elke ${config.pollingInterval/1000}s)`);
  if (zp.isLoggedIn) console.log(`  ☀️ Zonneplan: ingelogd als ${zp.userInfo?.email}`);
  console.log(`  📁 Data: ${readings.length} meetpunten\n`);
});
