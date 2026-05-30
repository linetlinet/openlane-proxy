// ══════════════════════════════════════════════════════════
// OPENLANE PROXY SERVER — pro Railway
// Scrape aktuální cenu z OpenLane aukce, vrátí JSON
// Env proměnné: OPENLANE_EMAIL, OPENLANE_PASS, PORT
// ══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

const OPENLANE_EMAIL = process.env.OPENLANE_EMAIL || '';
const OPENLANE_PASS  = process.env.OPENLANE_PASS  || '';

// ── Cache (30 sekund) ──────────────────────────────────────
let cache = {};   // { [auctionId]: { data, ts } }
const CACHE_TTL = 30 * 1000;

// ── CORS — povol z jakékoliv domény ───────────────────────
app.use(cors());

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'openlane-proxy' }));

// ── Hlavní endpoint: GET /price?auctionId=11030573 ────────
app.get('/price', async (req, res) => {
  const auctionId = req.query.auctionId;
  if (!auctionId) return res.status(400).json({ error: 'Chybí auctionId' });

  // Vrať z cache pokud je čerstvá
  const cached = cache[auctionId];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return res.json({ ...cached.data, fromCache: true });
  }

  // Jinak scrape
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ── Přihlášení ──────────────────────────────────────
    await page.goto('https://www.openlane.eu/cs/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // Vyplň email
    const emailSel = 'input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="mail"]';
    await page.waitForSelector(emailSel, { timeout: 10000 });
    await page.type(emailSel, OPENLANE_EMAIL, { delay: 50 });

    // Vyplň heslo
    const passSel = 'input[type="password"], input[name="password"], input[id*="password"]';
    await page.waitForSelector(passSel, { timeout: 5000 });
    await page.type(passSel, OPENLANE_PASS, { delay: 50 });

    // Klikni přihlásit
    const submitSel = 'button[type="submit"], button[class*="login"], button[class*="submit"]';
    await page.click(submitSel);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    // ── Jdi na aukci ───────────────────────────────────
    await page.goto(
      `https://www.openlane.eu/cs/car/info?auctionId=${auctionId}`,
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // Počkej až se načtou data (SPA)
    await new Promise(r => setTimeout(r, 3000));

    // ── Extrahuj cenu a čas ─────────────────────────────
    const data = await page.evaluate(() => {
      function getText(selectors) {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        return null;
      }

      // Různé selektory pro aktuální bid (zkusíme víc variant)
      const bidSelectors = [
        '[class*="current-bid"]',
        '[class*="currentBid"]',
        '[class*="highest-bid"]',
        '[class*="highestBid"]',
        '[class*="auction-price"]',
        '[data-testid*="bid"]',
        '[data-testid*="price"]',
        '[class*="bid-amount"]',
        '[class*="bidAmount"]',
        '[class*="price"] strong',
        '[class*="amount"]',
      ];

      // Selektory pro čas konce
      const timeSelectors = [
        '[class*="end-time"]',
        '[class*="endTime"]',
        '[class*="auction-end"]',
        '[class*="countdown"]',
        '[class*="time-left"]',
        '[data-testid*="time"]',
        '[data-testid*="end"]',
      ];

      const rawBid  = getText(bidSelectors);
      const rawTime = getText(timeSelectors);

      // Zkus najít číslo v textu ceny
      let priceNum = null;
      let currency = 'EUR';
      if (rawBid) {
        const match = rawBid.match(/[\d\s.,]+/);
        if (match) {
          priceNum = parseFloat(match[0].replace(/\s/g,'').replace(',','.'));
        }
        if (rawBid.includes('CZK') || rawBid.includes('Kč')) currency = 'CZK';
      }

      // Zkus najít všechna čísla na stránce pokud selektory selhaly
      let pageText = '';
      if (!rawBid) {
        pageText = document.body.innerText.substring(0, 2000);
      }

      return { rawBid, rawTime, priceNum, currency, pageText };
    });

    await browser.close();
    browser = null;

    const result = {
      auctionId,
      priceNum:   data.priceNum,
      currency:   data.currency,
      rawBid:     data.rawBid,
      rawTime:    data.rawTime,
      updatedAt:  new Date().toISOString(),
      updatedTs:  Date.now(),
      ok: !!data.priceNum
    };

    // Ulož do cache
    cache[auctionId] = { data: result, ts: Date.now() };

    res.json(result);

  } catch (err) {
    if (browser) { try { await browser.close(); } catch(e) {} }
    console.error('Scrape error:', err.message);
    // Vrať starou cache i když je stará, lepší než chyba
    if (cache[auctionId]) {
      return res.json({ ...cache[auctionId].data, fromCache: true, stale: true });
    }
    res.status(500).json({ error: err.message, ok: false });
  }
});

app.listen(PORT, () => console.log(`Proxy běží na portu ${PORT}`));
