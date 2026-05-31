// ══════════════════════════════════════════════════════════
// OPENLANE PROXY SERVER — pro Render.com (zdarma)
// Přihlásí se na OpenLane API, vrátí aktuální cenu aukce
// Env proměnné: OPENLANE_EMAIL, OPENLANE_PASS, PORT
// ══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const OPENLANE_EMAIL = process.env.OPENLANE_EMAIL || '';
const OPENLANE_PASS  = process.env.OPENLANE_PASS  || '';

// ── Cache (45 sekund) ─────────────────────────────────────
let cache = {};
const CACHE_TTL = 45 * 1000;

// ── Session token (získá se přihlášením) ─────────────────
let sessionToken  = null;
let tokenExpiry   = 0;

app.use(cors());

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'openlane-proxy', cached: Object.keys(cache).length });
});

// ── HTTP helper ───────────────────────────────────────────
function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, headers: res.headers, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ── Přihlášení na OpenLane ────────────────────────────────
async function getToken() {
  if (sessionToken && Date.now() < tokenExpiry) return sessionToken;

  console.log('Přihlašuji se na OpenLane...');

  // Zkus různé login endpointy OpenLane
  const loginPayload = JSON.stringify({ email: OPENLANE_EMAIL, password: OPENLANE_PASS });

  const endpoints = [
    { host: 'api.openlane.eu',  path: '/auth/login' },
    { host: 'api.openlane.eu',  path: '/v1/auth/login' },
    { host: 'www.openlane.eu',  path: '/api/auth/login' },
    { host: 'www.openlane.eu',  path: '/cs/api/login' },
  ];

  for (const ep of endpoints) {
    try {
      const r = await httpRequest({
        hostname: ep.host,
        path: ep.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Length': Buffer.byteLength(loginPayload)
        }
      }, loginPayload);

      console.log(`Login ${ep.host}${ep.path}: HTTP ${r.status}`);

      // Hledej token v různých místech odpovědi
      if (r.status === 200 || r.status === 201) {
        const token = r.body?.token || r.body?.access_token || r.body?.accessToken
                   || r.body?.data?.token || r.body?.jwt;
        const cookie = r.headers?.['set-cookie'];

        if (token) {
          sessionToken = token;
          tokenExpiry  = Date.now() + 3600 * 1000; // 1 hodina
          console.log('Token získán z body');
          return sessionToken;
        }
        if (cookie) {
          sessionToken = cookie.join('; ');
          tokenExpiry  = Date.now() + 3600 * 1000;
          console.log('Token získán z cookie');
          return sessionToken;
        }
      }
    } catch(e) {
      console.log(`Login ${ep.host}${ep.path}: chyba ${e.message}`);
    }
  }

  throw new Error('Přihlášení selhalo — žádný endpoint nefungoval');
}

// ── Načti data aukce ──────────────────────────────────────
async function fetchAuctionData(auctionId) {
  const token = await getToken();

  const authHeader = token.includes('=') ? `Cookie: ${token}` : `Bearer ${token}`;
  const isBearer   = !token.includes('=');

  const endpoints = [
    { host: 'api.openlane.eu', path: `/v1/auctions/${auctionId}` },
    { host: 'api.openlane.eu', path: `/auctions/${auctionId}` },
    { host: 'api.openlane.eu', path: `/v1/cars/${auctionId}` },
    { host: 'www.openlane.eu', path: `/api/auctions/${auctionId}` },
    { host: 'www.openlane.eu', path: `/cs/api/car/info?auctionId=${auctionId}` },
  ];

  for (const ep of endpoints) {
    try {
      const headers = {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      if (isBearer) headers['Authorization'] = `Bearer ${token}`;
      else          headers['Cookie'] = token;

      const r = await httpRequest({ hostname: ep.host, path: ep.path, method: 'GET', headers });
      console.log(`Auction ${ep.host}${ep.path}: HTTP ${r.status}`);

      if (r.status === 200 && typeof r.body === 'object') {
        // Hledej cenu v různých polích
        const b = r.body;
        const price = b.currentBid ?? b.current_bid ?? b.highestBid ?? b.highest_bid
                   ?? b.price ?? b.currentPrice ?? b.data?.currentBid ?? b.auction?.currentBid;
        const endTime = b.endTime ?? b.end_time ?? b.auctionEnd ?? b.data?.endTime;

        if (price !== undefined) {
          return { priceNum: price, currency: b.currency || 'EUR', endTime, rawResponse: b };
        }
        // Vrať surová data pro debugging
        return { priceNum: null, rawResponse: b, endTime };
      }
    } catch(e) {
      console.log(`Auction fetch ${ep.path}: ${e.message}`);
    }
  }

  throw new Error('Data aukce nenalezena');
}

// ── Hlavní endpoint ───────────────────────────────────────
app.get('/price', async (req, res) => {
  const auctionId = req.query.auctionId;
  if (!auctionId) return res.status(400).json({ error: 'Chybí auctionId' });

  // Cache
  const cached = cache[auctionId];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return res.json({ ...cached.data, fromCache: true });
  }

  try {
    const data = await fetchAuctionData(auctionId);
    const result = {
      auctionId,
      priceNum:  data.priceNum,
      currency:  data.currency || 'EUR',
      endTime:   data.endTime,
      updatedAt: new Date().toISOString(),
      updatedTs: Date.now(),
      ok: data.priceNum !== null && data.priceNum !== undefined,
      debug: data.rawResponse   // zobraz pro ladění, odstraň v produkci
    };
    cache[auctionId] = { data: result, ts: Date.now() };
    res.json(result);
  } catch(err) {
    console.error('Chyba:', err.message);
    if (cache[auctionId]) return res.json({ ...cache[auctionId].data, fromCache: true, stale: true });
    res.status(500).json({ error: err.message, ok: false });
  }
});

app.listen(PORT, () => console.log(`Proxy běží na portu ${PORT}`));
