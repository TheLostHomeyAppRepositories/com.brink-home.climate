'use strict';

const Homey = require('homey');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// OIDC / API constants
// ---------------------------------------------------------------------------
const URLS = {
  oidcAuth:   'https://www.brink-home.com/idsrv/connect/authorize',
  oidcToken:  'https://www.brink-home.com/idsrv/connect/token',
  systemList: 'https://www.brink-home.com/portal/api/v1.1/systems?pageSize=5',
};

const OIDC_CLIENT_ID    = 'spa';
const OIDC_REDIRECT_URI = 'https://www.brink-home.com/app/';
const OIDC_SCOPE        = 'openid api role locale';

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
// Minimal cookie jar — persists Set-Cookie headers across requests,
// scoped per host. Required because the Brink identity server sets
// session cookies on the first GET and expects them back on the POST.
// ---------------------------------------------------------------------------
class CookieJar {
  constructor() {
    this._cookies = {};
  }

  collect(url, headers) {
    const host = new URL(url).hostname;
    if (!this._cookies[host]) this._cookies[host] = {};
    const raw  = headers.raw ? headers.raw()['set-cookie'] : null;
    const list = raw || (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const entry of list) {
      const pair = entry.split(';')[0].trim();
      const eq   = pair.indexOf('=');
      if (eq > 0) {
        this._cookies[host][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }

  header(url) {
    const host = new URL(url).hostname;
    const jar  = this._cookies[host] || {};
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ---------------------------------------------------------------------------
// OIDC login — returns a bearer access token
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

  if (!loginPageResp.ok) {
    throw new Error(`OIDC authorize failed with status ${loginPageResp.status}`);
  }

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
    headers:  {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       jar.header(loginUrl),
    },
    body: formData.toString(),
  });

  jar.collect(loginUrl, credResp.headers);

  // Step 3 — follow redirects with cookies until we extract the auth code
  const authCode = await followRedirectsForCode(credResp, loginUrl, state, jar);
  if (!authCode) throw new Error('Could not extract authorization code — check username/password');

  // Step 4 — exchange code for access token and return it
  return await exchangeCodeForToken(authCode, codeVerifier);
}

async function followRedirectsForCode(resp, baseUrl, expectedState, jar) {
  let location = resp.headers.get('location') || '';

  let code = extractCodeFromUrl(location, expectedState);
  if (code) return code;

  for (let i = 0; i < 10 && location; i++) {
    if (location.startsWith('/')) {
      const base = new URL(baseUrl);
      location   = `${base.protocol}//${base.host}${location}`;
    }

    code = extractCodeFromUrl(location, expectedState);
    if (code) return code;

    const r = await fetch(location, {
      method:   'GET',
      redirect: 'manual',
      headers:  { Cookie: jar.header(location) },
    });

    jar.collect(location, r.headers);
    location = r.headers.get('location') || '';

    code = extractCodeFromUrl(location, expectedState);
    if (code) return code;
  }
  return null;
}

function extractCodeFromUrl(url, expectedState) {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const returnedState = params.get('state');
    if (returnedState && returnedState !== expectedState) return null;
    return params.get('code');
  } catch {
    return null;
  }
}

async function exchangeCodeForToken(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  OIDC_REDIRECT_URI,
    client_id:     OIDC_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(URLS.oidcToken, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!resp.ok) throw new Error(`OIDC token exchange failed with status ${resp.status}`);

  const payload = await resp.json();
  if (!payload.access_token) throw new Error('OIDC token response did not contain an access token');

  return payload.access_token;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log('MyDriver has been initialized');
  }

  async onPair(session) {
    let username    = '';
    let password    = '';
    let accessToken = null;

    // ------------------------------------------------------------------
    // login handler — validates credentials via OIDC and caches the token
    // ------------------------------------------------------------------
    session.setHandler('login', async (data) => {
      username = data.username;
      password = data.password;

      try {
        accessToken = await oidcLogin(username, password);
        return true;
      } catch (err) {
        this.error('Login failed:', err.message);
        return false;
      }
    });

    // ------------------------------------------------------------------
    // list_devices handler — fetches systems from the v1.1 API
    // ------------------------------------------------------------------
    session.setHandler('list_devices', async () => {
      // Re-use the token obtained during login; re-authenticate if needed
      if (!accessToken) {
        try {
          accessToken = await oidcLogin(username, password);
        } catch (err) {
          this.error('Re-authentication failed:', err.message);
          return [];
        }
      }

      const response = await fetch(URLS.systemList, {
        method:  'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept':        'application/json',
        },
      });

      if (!response.ok) {
        this.error('Failed to fetch system list:', response.status);
        return [];
      }

      const data  = await response.json();
      const items = data.items || [];

      this.log(`Found ${items.length} system(s)`);

      return items.map(system => ({
        name: system.systemName || 'Brink Home',
        data: {
          id: 'brink-home-device-' + system.systemShareId + Math.floor(10000 + Math.random() * 90000),
        },
        settings: {
          username,
          password,
        },
        store: {
          deviceId: system.systemShareId,
        },
      }));
    });
  }

};