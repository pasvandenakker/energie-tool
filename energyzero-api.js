// EnergyZero API — publieke dag-vooruit prijzen (dynamische energie)
// API: https://api.energyzero.nl/v1/energyprices
const https = require('https');

class EnergyZeroApi {
  constructor() {
    this.cache = { electricity: null, gas: null, fetchedAt: null };
  }

  _fetch(path) {
    return new Promise((resolve, reject) => {
      https.get('https://api.energyzero.nl' + path, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Parse fout')); }
        });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
    });
  }

  // Haal uurlijkse elektriciteitsprijzen voor een datum (lokaal NL)
  async getElectricityPrices(dateStr, interval = 4) {
    // dateStr: '2026-07-02' (lokaal)
    // interval: 4 = uur, 3 = kwartier
    // Converteer naar UTC: NL is UTC+1 (CET) of UTC+2 (CEST)
    const fromDate = dateStr + 'T22:00:00.000Z';
    const tillDate = dateStr + 'T21:59:59.999Z';

    const url = `/v1/energyprices?fromDate=${fromDate}&tillDate=${tillDate}&interval=${interval}&usageType=1&inclBtw=true`;
    const data = await this._fetch(url);

    if (data && data.Prices) {
      return data.Prices.map(p => ({
        date: p.readingDate,
        price: p.price, // €/kWh inclusief BTW
      }));
    }
    return [];
  }

  async getGasPrice(dateStr) {
    const fromDate = dateStr + 'T22:00:00.000Z';
    const tillDate = dateStr + 'T21:59:59.999Z';

    const url = `/v1/energyprices?fromDate=${fromDate}&tillDate=${tillDate}&interval=5&usageType=3&inclBtw=true`;
    const data = await this._fetch(url);

    if (data && data.Prices && data.Prices.length > 0) {
      return data.Prices.map(p => ({
        date: p.readingDate,
        price: p.price, // €/m³
      }));
    }
    return [];
  }

  // Gemiddelde dynamische prijs voor vandaag
  async getTodayAverage() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);

    const prices = await this.getElectricityPrices(dateStr);
    if (prices.length === 0) return null;

    const avg = prices.reduce((s, p) => s + p.price, 0) / prices.length;
    const min = Math.min(...prices.map(p => p.price));
    const max = Math.max(...prices.map(p => p.price));
    return { avg, min, max, count: prices.length, date: dateStr, prices };
  }

  // Laagste prijzen voor komende uren
  async getCheapestHours(hoursAhead = 8) {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const now = today.getTime();

    const prices = await this.getElectricityPrices(dateStr);
    const future = prices.filter(p => new Date(p.date).getTime() > now);
    const upcoming = future.slice(0, hoursAhead);

    if (upcoming.length === 0) return [];

    const sorted = [...upcoming].sort((a, b) => a.price - b.price);
    const avg = upcoming.reduce((s, p) => s + p.price, 0) / upcoming.length;
    return {
      cheapest: sorted.slice(0, 3),
      average: avg,
      upcoming: upcoming.map(p => ({
        ...p,
        hour: new Date(p.date).getHours(),
      })),
    };
  }
}

module.exports = EnergyZeroApi;
