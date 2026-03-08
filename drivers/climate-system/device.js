'use strict';

const Homey = require('homey');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// API / OIDC constants  Brink API v1.1
// ---------------------------------------------------------------------------
const URLS = {
  webp:          'https://www.brink-home.com',
  oidcAuth:      'https://www.brink-home.com/idsrv/connect/authorize',
  oidcToken:     'https://www.brink-home.com/idsrv/connect/token',
  systemList:    'https://www.brink-home.com/portal/api/v1.1/systems?pageSize=5',
  uidescription: 'https://www.brink-home.com/portal/api/v1.1/systems', // + /{systemId}/uidescription
  writeParams:   'https://www.brink-home.com/portal/api/v1.1/systems', // + /{systemId}/parameter-values
};

const OIDC_CLIENT_ID    = 'spa';
const OIDC_REDIRECT_URI = 'https://www.brink-home.com/app/';
const OIDC_SCOPE        = 'openid api role locale';
const WRITE_VALUE_STATE = 0;

// Maps German API parameter names to local keys
const PARAM_NAME_MAP = {
  'Lüftungsstufe':              'ventilation',
  'Betriebsart':                'mode',
  'Status Filtermeldung':       'filter',
  'Status Bypassklappe':        'bypass_status',
  'Funktion der Bypass Klappe': 'bypass_operation', // NEW writable param
};

let accessToken       = null;
let tokenExpiry       = 0;
let refreshToken      = null;
let systemId          = null;
let ventilationId     = null;
let modeId            = null;
let bypassOperationId = null;
let postModeValue        = '0';
let postVentilationValue = '4';
let intervalHandle = null;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function generateCodeVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function generateRandomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// Minimal cookie jar — persists Set-Cookie headers across requests per host.
// Required: the Brink identity server sets session cookies on the first GET
// and expects them back on the subsequent form POST.
// ---------------------------------------------------------------------------
class CookieJar {
  constructor() { this._cookies = {}; }

  collect(url, headers) {
    const host = new URL(url).hostname;
    if (!this._cookies[host]) this._cookies[host] = {};
    const raw  = headers.raw ? headers.raw()['set-cookie'] : null;
    const list = raw || (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const entry of list) {
      const pair = entry.split(';')[0].trim();
      const eq   = pair.indexOf('=');
      if (eq > 0) this._cookies[host][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }

  header(url) {
    const jar = this._cookies[new URL(url).hostname] || {};
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ---------------------------------------------------------------------------
// OIDC login
// ---------------------------------------------------------------------------
async function oidcLogin(username, password) {
  const jar = new CookieJar();

  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomString();
  const nonce = generateRandomString();

  // Step 1 — GET authorize; identity server redirects to login page and sets
  //           session cookies that must be carried on the subsequent POST.
  const authParams = new URLSearchParams({
    client_id:             OIDC_CLIENT_ID,
    redirect_uri:          OIDC_REDIRECT_URI,
    response_type:         'code',
    scope:                 OIDC_SCOPE,
    state,
    nonce,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl  = `${URLS.oidcAuth}?${authParams}`;
  const loginPageResp = await fetch(authorizeUrl, {
    method:   'GET',
    redirect: 'follow',
    headers:  { Cookie: jar.header(authorizeUrl) },
  });

  if (!loginPageResp.ok) throw new Error(`OIDC authorize failed with status ${loginPageResp.status}`);

  jar.collect(loginPageResp.url || authorizeUrl, loginPageResp.headers);
  const loginUrl = loginPageResp.url || authorizeUrl;
  const html     = await loginPageResp.text();

  // Extract CSRF token
  const csrfMatch = html.match(/<input[^>]+name="__RequestVerificationToken"[^>]+value="([^"]+)"/i)
                 || html.match(/<input[^>]+value="([^"]+)"[^>]+name="__RequestVerificationToken"/i);
  if (!csrfMatch) throw new Error('Could not find CSRF token in OIDC login page');
  const csrfToken = csrfMatch[1];

  // Extract ReturnUrl
  const returnUrlMatch = html.match(/<input[^>]+name="ReturnUrl"[^>]+value="([^"]+)"/i)
                      || html.match(/<input[^>]+value="([^"]+)"[^>]+name="ReturnUrl"/i);
  const returnUrl = returnUrlMatch ? returnUrlMatch[1].replace(/&amp;/g, '&') : null;

  // Step 2 — POST credentials with cookies, do NOT auto-follow redirects
  const formData = new URLSearchParams({
    Username: username,
    Password: password,
    __RequestVerificationToken: csrfToken,
  });
  if (returnUrl) formData.set('ReturnUrl', returnUrl);

  const credResp = await fetch(loginUrl, {
    method:   'POST',
    redirect: 'manual',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(loginUrl) },
    body:     formData.toString(),
  });

  jar.collect(loginUrl, credResp.headers);

  // Step 3 — follow redirects with cookies to capture the authorization code
  const authCode = await followRedirectsForCode(credResp, loginUrl, state, jar);
  if (!authCode) throw new Error('Could not extract authorization code from OIDC flow');

  // Step 4 — exchange code for tokens
  await exchangeCodeForTokens(authCode, codeVerifier);
}

async function followRedirectsForCode(resp, baseUrl, expectedState, jar) {
  let location = resp.headers.get('location') || '';
  let code     = extractCodeFromUrl(location, expectedState);
  if (code) return code;

  for (let i = 0; i < 10 && location; i++) {
    if (location.startsWith('/')) {
      const base = new URL(baseUrl);
      location   = `${base.protocol}//${base.host}${location}`;
    }
    code = extractCodeFromUrl(location, expectedState);
    if (code) return code;

    const r = await fetch(location, { method: 'GET', redirect: 'manual', headers: { Cookie: jar.header(location) } });
    jar.collect(location, r.headers);
    location = r.headers.get('location') || '';
    code     = extractCodeFromUrl(location, expectedState);
    if (code) return code;
  }
  return null;
}

function extractCodeFromUrl(url, expectedState) {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const s = params.get('state');
    if (s && s !== expectedState) return null;
    return params.get('code');
  } catch { return null; }
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const resp = await fetch(URLS.oidcToken, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: OIDC_REDIRECT_URI, client_id: OIDC_CLIENT_ID, code_verifier: codeVerifier }).toString(),
  });
  if (!resp.ok) throw new Error(`OIDC token exchange failed with status ${resp.status}`);
  const payload = await resp.json();
  if (!payload.access_token) throw new Error('OIDC token response did not contain an access token');
  accessToken  = payload.access_token;
  refreshToken = payload.refresh_token || null;
  tokenExpiry  = Date.now() + ((payload.expires_in || 3599) - 60) * 1000;
}

async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token available');
  const resp = await fetch(URLS.oidcToken, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OIDC_CLIENT_ID }).toString(),
  });
  if (!resp.ok) { refreshToken = null; throw new Error(`Refresh token rejected (HTTP ${resp.status})`); }
  const payload = await resp.json();
  if (!payload.access_token) { refreshToken = null; throw new Error('Refresh response missing access_token'); }
  accessToken  = payload.access_token;
  refreshToken = payload.refresh_token || refreshToken;
  tokenExpiry  = Date.now() + ((payload.expires_in || 3599) - 60) * 1000;
}

async function ensureToken(username, password) {
  if (accessToken && Date.now() < tokenExpiry) return;
  if (refreshToken) {
    try { await refreshAccessToken(); return; }
    catch (err) { console.log('Refresh failed, re-login:', err.message); }
  }
  await oidcLogin(username, password);
}

function authHeaders() {
  return { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// Parameter extraction from v1.1 uidescription
// Recurses: root → navigationItems → parameterGroups → parameters[]
// ---------------------------------------------------------------------------
function extractParameters(navigationItems) {
  const out = {};
  for (const navItem of (navigationItems || [])) {
    for (const group of (navItem.parameterGroups || [])) {
      for (const param of (group.parameters || [])) {
        const key = PARAM_NAME_MAP[param.name || ''];
        if (key) out[key] = { name: param.name, value: param.value, valueId: param.valueId, listItems: param.listItems || [] };
      }
    }
    Object.assign(out, extractParameters(navItem.navigationItems || []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device class
// ---------------------------------------------------------------------------
module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    this.log('Device initialized');

    // Capability migrations for existing paired devices; add BYPASS Valve capability
    if (!this.hasCapability('operational_state.bypass')) {
      await this.addCapability('operational_state.bypass');
      this.log('Migration: Removed operational_state.bypass');
    }
    
    if (!this.hasCapability('operational_state.bypass_operation')) {
      await this.addCapability('operational_state.bypass_operation');
      this.log('Migration: added operational_state.bypass_operation');
    }

    const settings   = this.getSettings();
    const username   = settings.username;
    const password   = settings.password;
    const boostTimer = settings.boost_timer * 60000;
    const intervalMs = settings.interval * 60000;

    await this.runMainCycle(username, password);
    this.startInterval(username, password, intervalMs);
    this.registerCapabilityListeners(boostTimer);
    this.registerFlowCards();
  }

  async checkServerHealth(url) {
    try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; }
    catch { return false; }
  }

  async fetchSystemInfo(username, password) {
    await ensureToken(username, password);
    const response = await fetch(URLS.systemList, { method: 'GET', headers: authHeaders() });
    if (response.status === 401) {
      accessToken = null; tokenExpiry = 0;
      await ensureToken(username, password);
      return this.fetchSystemInfo(username, password);
    }
    if (!response.ok) throw new Error(`fetchSystemInfo failed: ${response.status}`);
    const items = (await response.json()).items || [];
    const deviceId = this.getStoreValue('deviceId');
    systemId = deviceId || (items.length > 0 ? items[0].systemShareId : null);
  }

  async fetchGuiDescription(username, password) {
    await ensureToken(username, password);
    const response = await fetch(`${URLS.uidescription}/${systemId}/uidescription`, { method: 'GET', headers: authHeaders() });
    if (response.status === 401) {
      accessToken = null; tokenExpiry = 0;
      await ensureToken(username, password);
      return this.fetchGuiDescription(username, password);
    }
    if (!response.ok) throw new Error(`fetchGuiDescription failed: ${response.status}`);

    const details    = await response.json();
    const parameters = extractParameters((details.root || {}).navigationItems || []);

    const ventilation     = parameters['ventilation'];
    const mode            = parameters['mode'];
    const filter          = parameters['filter'];
    const bypassStatus    = parameters['bypass_status'];
    const bypassOperation = parameters['bypass_operation'];

    // Cache valueIds for write operations
    ventilationId     = ventilation.valueId;
    modeId            = mode.valueId;
    bypassOperationId = bypassOperation ? bypassOperation.valueId : null;

    // Remember pre-boost state (don't overwrite while boost is active)
    if (this.getCapabilityValue('button') === false) {
      postVentilationValue = ventilation.value;
      postModeValue        = mode.value;
      //this.log('Last setting Ventilation: ' + postVentilationValue + ' & Mode: ' + postModeValue)
    }

    // Filter alarm
    this.setCapabilityValue('alarm_generic', filter.value == 1);

    // Ventilation & mode
    this.setCapabilityValue('operational_state',     String(ventilation.value));
    this.setCapabilityValue('operational_state_2',   String(ventilation.value));
    this.setCapabilityValue('fan_mode',              String(mode.value));
    this.setCapabilityValue('operational_state.fan', String(mode.value));

    // Bypass valve status (read-only, 255 = not fitted)
    if (this.hasCapability('operational_state.bypass') && bypassStatus && bypassStatus.value !== 255) {
      this.setCapabilityValue('operational_state.bypass', bypassStatus.value);
    }

    // Bypass operation mode (Pick-List — new in v1.1)
    if (this.hasCapability('operational_state.bypass_operation') && bypassOperation && bypassOperation.value !== undefined) {
      this.setCapabilityValue('operational_state.bypass_operation', String(bypassOperation.value));
    }

    console.log('Fetch details from Brink portal API v1.1. [Done]');
  }

  async runMainCycle(username, password) {
    if (!await this.checkServerHealth(URLS.webp)) {
      this.log('Server unreachable, retrying in 1 minute...');
      setTimeout(() => this.runMainCycle(username, password), 60000);
      return;
    }
    try {
      await ensureToken(username, password);
      await this.fetchSystemInfo(username, password);
      await this.fetchGuiDescription(username, password);
    } catch (err) {
      this.log('Error in main cycle:', err.message);
    }
  }

  restartInterval(username, password, intervalMs) {
    if (intervalHandle) this.homey.clearInterval(intervalHandle);
    intervalHandle = this.homey.setInterval(() => this.runMainCycle(username, password), intervalMs);
    this.log('Restart.');
  }

  startInterval(username, password, intervalMs) {
    this.restartInterval(username, password, intervalMs);
    this.homey.setInterval(() => {
      this.log('Starting interval...');
      setTimeout(() => this.restartInterval(username, password, intervalMs), 60000);
    }, 7200000);
  }

  registerCapabilityListeners(boostTimer) {
    this.registerMultipleCapabilityListener(['fan_mode'], async ({ fan_mode }) => {
      await this.sendWriteParams([{ valueId: modeId, value: fan_mode }]);
      this.setCapabilityValue('fan_mode', fan_mode);
      this.setCapabilityValue('operational_state.fan', fan_mode);
      //this.log('change fan_mode: ' + fan_mode);
    });

    this.registerMultipleCapabilityListener(['operational_state'], async ({ operational_state }) => {
      const values = operational_state === '4' || operational_state === 4
        ? [{ valueId: modeId, value: '0' }]
        : [{ valueId: modeId, value: '1' }, { valueId: ventilationId, value: operational_state }];
      await this.sendWriteParams(values);
      this.setCapabilityValue('operational_state',   operational_state);
      this.setCapabilityValue('operational_state_2', operational_state);
      //this.log('change Ventilation: ' + operational_state);
    });

    this.registerMultipleCapabilityListener(['button'], async ({ button }) => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      if (button) {
        await this.sendWriteParams([{ valueId: modeId, value: '1' }, { valueId: ventilationId, value: '3' }]);
        this.setCapabilityValue('operational_state',   '3');
        this.setCapabilityValue('operational_state_2', '3');
        this.setCapabilityValue('operational_state.fan', '1');
        this.setCapabilityValue('fan_mode', '1');
        this.homey.setTimeout(async () => {
          await this.sendWriteParams([{ valueId: modeId, value: '1' }, { valueId: ventilationId, value: '1' }]);       
            await delay(3000);
              await this.sendWriteParams([{ valueId: modeId, value: postModeValue }, { valueId: ventilationId, value: postVentilationValue }]);
          //this.log('Boost timer ended; back to normal')
          this.setCapabilityValue('button', false);
        }, boostTimer);
      } else {
        await this.sendWriteParams([{ valueId: modeId, value: '1' }, { valueId: ventilationId, value: '1' }]);
          await delay(3000);
            await this.sendWriteParams([{ valueId: modeId, value: postModeValue }, { valueId: ventilationId, value: postVentilationValue }]);
        this.setCapabilityValue('button',              false);
        this.setCapabilityValue('operational_state',   postVentilationValue);
        this.setCapabilityValue('operational_state_2', postVentilationValue);
        this.setCapabilityValue('operational_state.fan', postModeValue);
        this.setCapabilityValue('fan_mode', postModeValue);
        //this.log('Boost timer ended by user; back to normal')
      }
    });

    // NEW — bypass operation: 0=Automatic, 1=Closed, 2=Open
    this.registerMultipleCapabilityListener(['operational_state.bypass_operation'], async (values) => {
      const bypassOp = values['operational_state.bypass_operation'];
      if (!bypassOperationId) { this.log('Bypass operation valueId not yet available'); return; }
      await this.sendWriteParams([{ valueId: bypassOperationId, value: bypassOp }]);
      this.setCapabilityValue('operational_state.bypass_operation', bypassOp);
      this.log(`Bypass operation set to: ${bypassOp}`);
    });
  }

  registerFlowCards() {
    // Fan speed action
    this.homey.flow.getActionCard('operational_state_flow_card').registerRunListener(async (args) => {
      const flowArg = args.operational_state;
      await this.sendWriteParams([
        { valueId: modeId,        value: flowArg === '4' ? '0' : '1' },
        { valueId: ventilationId, value: flowArg },
      ]);
      this.setCapabilityValue('operational_state',   flowArg);
      this.setCapabilityValue('operational_state_2', flowArg);
    });

    // Boost action
    this.homey.flow.getActionCard('press').registerRunListener(async () => {
      await this.sendWriteParams([{ valueId: modeId, value: '1' }, { valueId: ventilationId, value: '3' }]);
      this.setCapabilityValue('operational_state',   '3');
      this.setCapabilityValue('operational_state_2', '3');
    });

    // NEW — bypass operation action card
    this.homey.flow.getActionCard('set_bypass_operation').registerRunListener(async (args) => {
      if (!bypassOperationId) return;
      const value = args.bypass_operation;
      await this.sendWriteParams([{ valueId: bypassOperationId, value }]);
      this.setCapabilityValue('operational_state.bypass_operation', value);
    });
  }

  async sendWriteParams(values) {
    const settings = this.getSettings();
    await ensureToken(settings.username, settings.password);
    await fetch(`${URLS.writeParams}/${systemId}/parameter-values`, {
      method:  'PUT',
      headers: authHeaders(),
      body:    JSON.stringify({
        writeValues: values.map(v => ({ valueId: v.valueId, value: v.value, state: WRITE_VALUE_STATE })),
      }),
    });
    //console.log('PUT changes to Brink portal v1.1.');
  }

  async onAdded() {
    this.log('Device added');
    const s = this.getSettings();
    this.restartInterval(s.username, s.password, s.interval * 60000);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed');
    this.homey.clearInterval(intervalHandle);
    accessToken = null; tokenExpiry = 0; refreshToken = null;
    this.onInit();
  }

  async onRenamed(name) {
    this.log('Device renamed');
    const s = this.getSettings();
    this.restartInterval(s.username, s.password, s.interval * 60000);
  }

  async onDeleted() {
    this.log('Device deleted');
    if (intervalHandle) this.homey.clearInterval(intervalHandle);
  }
};