// Zonneplan API — reverse-engineered op basis van Home Assistant integratie
// Bron: https://github.com/fsaris/home-assistant-zonneplan-one
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_VERSION = '5.10.1';
const BASE = 'app-api.zonneplan.nl';
const SESSION_PATH = path.join(__dirname, 'zp-session.json');

class ZonneplanAPI {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiryDate = null;
    this.connectionUuid = null;
    this.addressUuid = null;
    this.contracts = [];
    this.userInfo = null;
    this.loginUuid = null;

    // Laad opgeslagen sessie
    this._loadSession();
  }

  get isLoggedIn() {
    return !!this.accessToken && (!this.expiryDate || Date.now() < this.expiryDate);
  }

  get canRefresh() {
    return !!this.refreshToken;
  }

  // === REQUEST HELPERS ===
  _fetch(method, host, path, body, token) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: host,
        path,
        method,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'x-app-version': APP_VERSION,
          'x-app-environment': 'production',
        },
        timeout: 15000,
      };

      if (token) opts.headers['Authorization'] = 'Bearer ' + token;

      const req = (host === BASE ? https : http).request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, headers: res.headers, data: json });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, data: null, raw: data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  _api(method, path, body) {
    return this._fetch(method, BASE, path, body, this.accessToken);
  }

  _get(path) { return this._api('GET', path); }
  _post(path, body) { return this._api('POST', path, body); }

  // === AUTH FLOW ===
  async requestLogin(email) {
    const res = await this._fetch('POST', BASE, '/auth/request', { email });
    if ((res.status === 200 || res.status === 201) && res.data?.data?.uuid) {
      this.loginUuid = res.data.data.uuid;
      return { success: true, uuid: this.loginUuid, message: 'Check je email en klik op de inloglink van Zonneplan' };
    }
    return { success: false, error: res.data?.message || 'Onbekende fout', status: res.status };
  }

  async pollLogin() {
    if (!this.loginUuid) return { success: false, error: 'Geen login UUID. Start eerst requestLogin().' };

    const res = await this._fetch('GET', BASE, '/auth/request/' + this.loginUuid);
    if (res.status !== 200 || !res.data?.data) {
      return { success: false, error: 'Nog niet beschikbaar', status: res.status };
    }

    const d = res.data.data;
    if (d.is_activated && d.password) {
      // Exchange OTP for tokens
      const tokenRes = await this._fetch('POST', BASE, '/oauth/token', {
        grant_type: 'one_time_password',
        email: d.email,
        password: d.password,
      });

      if (tokenRes.status === 200 && tokenRes.data?.access_token) {
        this._setTokens(tokenRes.data);
        await this._fetchUserInfo();
        return { success: true, tokens: tokenRes.data };
      }
      return { success: false, error: 'Token exchange mislukt', status: tokenRes.status };
    }

    return { success: false, error: 'Nog niet geactiveerd — klik de link in je email', poll: true };
  }

  async refreshAccessToken() {
    if (!this.refreshToken) return false;
    const res = await this._fetch('POST', BASE, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    if (res.status === 200 && res.data?.access_token) {
      this._setTokens(res.data);
      return true;
    }
    return false;
  }

  async _fetchUserInfo() {
    const res = await this._get('/user-accounts/me');
    if (res.status === 200 && res.data?.data) {
      this.userInfo = res.data.data.user_account;
      const groups = res.data.data.address_groups || [];
      if (groups.length > 0) {
        // Eerste adresgroep met een connection pakken
        for (const g of groups) {
          this.addressUuid = g.uuid;
          if (g.connections && g.connections.length > 0) {
            this.connectionUuid = g.connections[0].uuid;
            this.contracts = g.connections[0].contracts || [];
            break;
          }
        }
      }
      this._saveSession();
      return true;
    }
    return false;
  }

  _setTokens(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    if (data.expires_in) {
      this.expiryDate = Date.now() + (data.expires_in - 60) * 1000;
    }
    this._saveSession();
  }

  // === DATA ===
  _ensureAuth() {
    if (!this.accessToken) throw new Error('Niet ingelogd');
  }

  async getSummary() {
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/summary');
    if (res.status === 200 && res.data?.data) return res.data.data;
    if (res.status === 401 && await this.refreshAccessToken()) return this.getSummary();
    return null;
  }

  async getElectricityHourly(dateStr) {
    // dateStr: '2025-06-01'
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/electricity-delivered/charts/hours?date=' + dateStr);
    if (res.status === 200 && res.data?.data) {
      const groups = res.data.data.measurement_groups || [];
      for (const g of groups) {
        if (g.type === 'hours') return g.measurements || [];
      }
      return [];
    }
    if (res.status === 401 && await this.refreshAccessToken()) return this.getElectricityHourly(dateStr);
    return null;
  }

  async getElectricityDaily() {
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/electricity-delivered/charts/daily');
    if (res.status === 200 && res.data?.data) {
      const groups = res.data.data.measurement_groups || [];
      for (const g of groups) {
        if (g.type === 'days') return g.measurements || [];
      }
      return [];
    }
    if (res.status === 401 && await this.refreshAccessToken()) return this.getElectricityDaily();
    return null;
  }

  async getElectricityMonthly() {
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/electricity-delivered/charts/monthly');
    if (res.status === 200 && res.data?.data) {
      const groups = res.data.data.measurement_groups || [];
      for (const g of groups) {
        if (g.type === 'months') return g.measurements || [];
      }
      return [];
    }
    if (res.status === 401 && await this.refreshAccessToken()) return this.getElectricityMonthly();
    return null;
  }

  async getElectricityYearly() {
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/electricity-delivered/charts/yearly');
    if (res.status === 200 && res.data?.data) {
      const groups = res.data.data.measurement_groups || [];
      for (const g of groups) {
        if (g.type === 'years') return g.measurements || [];
      }
      return [];
    }
    if (res.status === 401 && await this.refreshAccessToken()) return this.getElectricityYearly();
    return null;
  }

  async getGasHourly(dateStr) {
    this._ensureAuth();
    const res = await this._get('/connections/' + this.connectionUuid + '/gas/charts/hours?date=' + dateStr);
    if (res.status === 200 && res.data?.data) {
      const groups = res.data.data.measurement_groups || [];
      for (const g of groups) {
        if (g.type === 'hours') return g.measurements || [];
      }
      return [];
    }
    if (res.status === 401 && await this.refreshAccessToken()) return this.getGasHourly(dateStr);
    return null;
  }

  async getContracts() {
    this._ensureAuth();
    await this._fetchUserInfo(); // vernieuwt ook contracts
    return this.contracts;
  }

  async getTariffs() {
    // Haal huidige uurtarieven op van Zonneplan
    // Dit zit in het summary endpoint
    const summary = await this.getSummary();
    if (summary) {
      const pricing = summary.pricing_profiles || {};
      return {
        current: pricing.current,
        today: pricing.today,
        tomorrow: pricing.tomorrow,
      };
    }
    return null;
  }

  async getFullHistory() {
    // Haal alle beschikbare historie op (maand- en jaarcijfers)
    const monthly = await this.getElectricityMonthly();
    const yearly = await this.getElectricityYearly();

    return { monthly, yearly };
  }

  // === SESSION ===
  _saveSession() {
    try {
      fs.writeFileSync(SESSION_PATH, JSON.stringify({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiryDate: this.expiryDate,
        connectionUuid: this.connectionUuid,
        addressUuid: this.addressUuid,
        contracts: this.contracts,
        userInfo: this.userInfo,
      }));
    } catch {}
  }

  _loadSession() {
    try {
      if (fs.existsSync(SESSION_PATH)) {
        const d = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
        this.accessToken = d.accessToken;
        this.refreshToken = d.refreshToken;
        this.expiryDate = d.expiryDate;
        this.connectionUuid = d.connectionUuid;
        this.addressUuid = d.addressUuid;
        this.contracts = d.contracts || [];
        this.userInfo = d.userInfo;
      }
    } catch {}
  }

  // Converteer Zonneplan data naar tool-formaat
  processMeasurementsToToolData(monthlyData) {
    if (!monthlyData || !Array.isArray(monthlyData)) return null;

    const ZON_FACTOREN = [0.034, 0.055, 0.107, 0.141, 0.155, 0.148, 0.140, 0.119, 0.088, 0.055, 0.027, 0.017];

    // monthlyData = [{date: "2025-01-01", values: {d: 123000, p: 45000}}, ...]
    // d = delivered in Wh, p = produced in Wh (beide totaal over de maand)
    // We moeten de tool voeden met maandcijfers (kWh)

    const maandCijfers = [];
    let totaalDelivered = 0;
    let totaalProduced = 0;

    for (const m of monthlyData) {
      const d = m.values?.d || 0;
      const p = m.values?.p || 0;
      totaalDelivered += d;
      totaalProduced += p;

      const dt = new Date(m.date);
      const month = dt.getMonth(); // 0-11

      maandCijfers.push({
        month,
        label: ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'][month],
        deliveredKwh: d / 1000,     // Wh → kWh
        producedKwh: p / 1000,      // Wh → kWh
        nettoKwh: (p - d) / 1000,   // positief = teruglevering
      });
    }

    return {
      maandCijfers,
      totaalDeliveredKwh: totaalDelivered / 1000,
      totaalProducedKwh: totaalProduced / 1000,
      totaalNettoKwh: (totaalProduced - totaalDelivered) / 1000,
    };
  }

  processSummaryToToolData(summary) {
    if (!summary) return null;
    return {
      totalDelivered: (summary.total_delivered || 0) / 1000, // Wh→kWh
      totalProduced: (summary.total_produced || 0) / 1000,
      currentTariff: summary.current_tariff_incl_vat,
      currentTariffExVat: summary.current_tariff_ex_vat,
      currentTariffGroup: summary.current_tariff_group,
      status: summary.status_message,
      tip: summary.status_tip,
      sustainabilityScore: summary.sustainability_score,
      p1Meter: {
        connected: summary.p1_reader?.connected,
        lastMeasurement: summary.p1_reader?.last_measurement,
      },
    };
  }
}

module.exports = ZonneplanAPI;
