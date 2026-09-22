/* ============================================================
   Crypto ICT Sweep+CISD - Professional Dashboard
   Semua data live ditarik client-side (tanpa backend sendiri).
   Sumber: Bybit v5 public API, CoinGecko public API, alternative.me,
   CFTC Socrata (COT), widget resmi TradingView.
   ============================================================ */

const COINS = ["1000PEPEUSDT", "AAVEUSDT", "ARBUSDT", "ASTERUSDT", "BNBUSDT", "DOTUSDT", "ENAUSDT",
  "ETCUSDT", "HBARUSDT", "HYPEUSDT", "ICPUSDT", "JSTUSDT", "KASUSDT", "LINKUSDT",
  "LITUSDT", "LTCUSDT", "MNTUSDT", "MORPHOUSDT", "POLUSDT", "SHIB1000USDT", "SKYUSDT",
  "SUIUSDT", "TRXUSDT", "VVVUSDT", "WLDUSDT", "WLFIUSDT", "XLMUSDT", "XRPUSDT"];

const BYBIT_BASE = "https://api.bybit.com";
const CG_BASE = "https://api.coingecko.com/api/v3";

/* ---------- util ---------- */
function baseSymbol(sym) {
  // 1000PEPEUSDT -> PEPE, SHIB1000USDT -> SHIB, AAVEUSDT -> AAVE
  let s = sym.replace(/USDT$/, "");
  s = s.replace(/^1000/, "").replace(/1000$/, "");
  return s;
}
function timeAgo(ts) {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return diffSec + "d lalu";
  const m = Math.floor(diffSec / 60);
  if (m < 60) return m + "m lalu";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "j lalu";
  return Math.floor(h / 24) + "hr lalu";
}
function setUpdated(elId, ts) {
  const el = document.getElementById(elId);
  if (el) el.textContent = "terakhir update: " + timeAgo(ts);
}
function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > maxAgeMs) return null;
    return obj.v;
  } catch (e) { return null; }
}
function cacheSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch (e) {}
}
async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function fmtNum(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return Number(n).toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

/* ============================================================
   BYBIT: ambil semua ticker linear sekali panggil
   (harga, %change 24h, high/low 24h, funding rate, open interest)
   ============================================================ */
let bybitTickersCache = null;
async function getBybitTickers() {
  if (bybitTickersCache) return bybitTickersCache;
  const cached = cacheGet("bybit_tickers", 60 * 1000);
  if (cached) { bybitTickersCache = cached; return cached; }
  const data = await fetchJson(`${BYBIT_BASE}/v5/market/tickers?category=linear`);
  const list = (data.result && data.result.list) || [];
  const map = {};
  list.forEach(t => { map[t.symbol] = t; });
  bybitTickersCache = map;
  cacheSet("bybit_tickers", map);
  return map;
}

async function getLongShortRatio(symbol) {
  try {
    const data = await fetchJson(`${BYBIT_BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=1`);
    const row = data.result && data.result.list && data.result.list[0];
    if (!row) return null;
    return { buyRatio: parseFloat(row.buyRatio), sellRatio: parseFloat(row.sellRatio) };
  } catch (e) { return null; }
}

async function getDailyKlines(symbol, days = 31) {
  const cacheKey = "kline_" + symbol;
  const cached = cacheGet(cacheKey, 6 * 3600 * 1000);
  if (cached) return cached;
  try {
    const data = await fetchJson(`${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=${days}`);
    const list = (data.result && data.result.list) || [];
    const closes = list.map(r => parseFloat(r[4])).reverse(); // oldest -> newest
    cacheSet(cacheKey, closes);
    return closes;
  } catch (e) { return []; }
}

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  a = a.slice(-n); b = b.slice(-n);
  const retA = []; const retB = [];
  for (let i = 1; i < n; i++) {
    retA.push(Math.log(a[i] / a[i - 1]));
    retB.push(Math.log(b[i] / b[i - 1]));
  }
  const m = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
  const mA = m(retA), mB = m(retB);
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < retA.length; i++) {
    num += (retA[i] - mA) * (retB[i] - mB);
    denA += (retA[i] - mA) ** 2;
    denB += (retB[i] - mB) ** 2;
  }
  if (denA === 0 || denB === 0) return null;
  return num / Math.sqrt(denA * denB);
}

/* ============================================================
   COINGECKO: market cap (join by symbol), global data
   ============================================================ */
let cgMarketsCache = null;
async function getCoinGeckoMarkets() {
  if (cgMarketsCache) return cgMarketsCache;
  const cached = cacheGet("cg_markets", 5 * 60 * 1000);
  if (cached) { cgMarketsCache = cached; return cached; }
  try {
    const data = await fetchJson(`${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h`);
    const map = {};
    data.forEach(c => { map[c.symbol.toLowerCase()] = c; });
    cgMarketsCache = map;
    cacheSet("cg_markets", map);
    return map;
  } catch (e) { return {}; }
}

async function getCoinGeckoGlobal() {
  const cached = cacheGet("cg_global", 5 * 60 * 1000);
  if (cached) return cached;
  try {
    const data = await fetchJson(`${CG_BASE}/global`);
    cacheSet("cg_global", data.data);
    return data.data;
  } catch (e) { return null; }
}

/* ============================================================
   FEAR & GREED (alternative.me)
   ============================================================ */
async function getFearGreed() {
  const cached = cacheGet("fng", 30 * 60 * 1000);
  if (cached) return cached;
  try {
    const data = await fetchJson("https://api.alternative.me/fng/?limit=1");
    const row = data.data && data.data[0];
    cacheSet("fng", row);
    return row;
  } catch (e) { return null; }
}

/* ============================================================
   CFTC COT REPORT (Socrata) - positioning mingguan forex major
   ============================================================ */
const COT_CODES = {
  "EUR": "099741", "GBP": "096742", "JPY": "097741", "AUD": "232741",
  "CAD": "090741", "CHF": "092741", "NZD": "112741",
};
async function getCotForCurrency(ccy) {
  const code = COT_CODES[ccy];
  if (!code) return null;
  const cacheKey = "cot_" + ccy;
  const cached = cacheGet(cacheKey, 24 * 3600 * 1000);
  if (cached) return cached;
  try {
    const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=${code}&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`;
    const data = await fetchJson(url);
    const row = data && data[0];
    if (!row) return null;
    const result = {
      date: row.report_date_as_yyyy_mm_dd ? row.report_date_as_yyyy_mm_dd.slice(0, 10) : "-",
      netNonComm: parseInt(row.lev_money_positions_long || 0) - parseInt(row.lev_money_positions_short || 0),
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) { return null; }
}

/* ============================================================
   TAB: CRYPTO (tabel 28 coin: harga, %change, mcap, korelasi BTC, volatilitas)
   ============================================================ */
async function loadCryptoTab() {
  const tbody = document.getElementById("cryptoTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:20px;">Memuat data...</td></tr>`;
  try {
    const [tickers, cgMap] = await Promise.all([getBybitTickers(), getCoinGeckoMarkets()]);
    const btcCloses = await getDailyKlines("BTCUSDT");

    const rows = [];
    for (const sym of COINS) {
      const t = tickers[sym];
      if (!t) { rows.push({ sym, error: true }); continue; }
      const price = parseFloat(t.lastPrice);
      const chg = parseFloat(t.price24hPcnt) * 100;
      const hi = parseFloat(t.highPrice24h), lo = parseFloat(t.lowPrice24h);
      const range = price > 0 ? ((hi - lo) / price) * 100 : null;
      const base = baseSymbol(sym).toLowerCase();
      const cg = cgMap[base];
      rows.push({ sym, price, chg, range, mcap: cg ? cg.market_cap : null });
    }

    // korelasi ke BTC (async per coin, batch supaya tidak flood)
    const corrPromises = rows.map(async r => {
      if (r.error) return;
      const closes = await getDailyKlines(r.sym);
      r.corr = pearsonCorrelation(closes, btcCloses);
    });
    await Promise.all(corrPromises);

    rows.sort((a, b) => (b.range || 0) - (a.range || 0));

    tbody.innerHTML = rows.map(r => {
      if (r.error) return `<tr><td>${r.sym}</td><td colspan="5" style="color:var(--text-dim);">data tidak tersedia</td></tr>`;
      const chgClass = r.chg >= 0 ? "win" : "loss";
      const corrTxt = r.corr === null ? "-" : (r.corr >= 0 ? "+" : "") + r.corr.toFixed(2);
      return `<tr>
        <td>${baseSymbol(r.sym)}</td>
        <td>$${fmtNum(r.price, r.price < 1 ? 6 : 2)}</td>
        <td class="${chgClass}">${r.chg >= 0 ? "+" : ""}${fmtNum(r.chg, 2)}%</td>
        <td>${r.mcap ? "$" + fmtCompact(r.mcap) : "-"}</td>
        <td>${r.range !== null ? fmtNum(r.range, 2) + "%" : "-"}</td>
        <td>${corrTxt}</td>
      </tr>`;
    }).join("");
    setUpdated("cryptoUpdated", Date.now());
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);text-align:center;padding:20px;">Gagal memuat data crypto. Coba lagi nanti.</td></tr>`;
  }
}

/* ============================================================
   TAB: FUTURES DATA (funding rate, OI, long/short ratio)
   ============================================================ */
async function loadFuturesTab() {
  const tbody = document.getElementById("futuresTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px;">Memuat data...</td></tr>`;
  try {
    const tickers = await getBybitTickers();
    const rows = COINS.map(sym => {
      const t = tickers[sym];
      if (!t) return { sym, error: true };
      return {
        sym,
        funding: parseFloat(t.fundingRate) * 100,
        oi: parseFloat(t.openInterest),
        oiValue: parseFloat(t.openInterestValue),
      };
    });

    const lsPromises = rows.map(async r => {
      if (r.error) return;
      r.ls = await getLongShortRatio(r.sym);
    });
    await Promise.all(lsPromises);

    tbody.innerHTML = rows.map(r => {
      if (r.error) return `<tr><td>${r.sym}</td><td colspan="4" style="color:var(--text-dim);">data tidak tersedia</td></tr>`;
      const fundClass = r.funding >= 0 ? "win" : "loss";
      const lsTxt = r.ls ? `${(r.ls.buyRatio * 100).toFixed(0)}% / ${(r.ls.sellRatio * 100).toFixed(0)}%` : "-";
      return `<tr>
        <td>${baseSymbol(r.sym)}</td>
        <td class="${fundClass}">${r.funding >= 0 ? "+" : ""}${fmtNum(r.funding, 4)}%</td>
        <td>${fmtCompact(r.oi)}</td>
        <td>$${fmtCompact(r.oiValue)}</td>
        <td>${lsTxt}</td>
      </tr>`;
    }).join("");
    setUpdated("futuresUpdated", Date.now());
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);text-align:center;padding:20px;">Gagal memuat data futures. Coba lagi nanti.</td></tr>`;
  }
}

/* ============================================================
   TAB: OVERVIEW (Fear&Greed ringkas, BTC dominance, breadth)
   ============================================================ */
async function loadOverviewTab() {
  try {
    const [fng, global] = await Promise.all([getFearGreed(), getCoinGeckoGlobal()]);
    if (fng) {
      document.getElementById("ov_fng_val").textContent = fng.value;
      document.getElementById("ov_fng_label").textContent = fng.value_classification;
    }
    if (global) {
      document.getElementById("ov_btcd").textContent = fmtNum(global.market_cap_percentage.btc, 1) + "%";
      document.getElementById("ov_mcap").textContent = "$" + fmtCompact(global.total_market_cap.usd);
      const chg = global.market_cap_change_percentage_24h_usd;
      const el = document.getElementById("ov_mcap_chg");
      el.textContent = (chg >= 0 ? "+" : "") + fmtNum(chg, 2) + "%";
      el.className = chg >= 0 ? "win" : "loss";
    }
    const cgMap = await getCoinGeckoMarkets();
    const vals = Object.values(cgMap);
    const up = vals.filter(c => c.price_change_percentage_24h > 0).length;
    const down = vals.filter(c => c.price_change_percentage_24h <= 0).length;
    document.getElementById("ov_breadth").textContent = `${up} naik / ${down} turun`;
    setUpdated("overviewUpdated", Date.now());
  } catch (e) { /* biarkan placeholder default kalau gagal */ }
}

/* ============================================================
   TAB: SENTIMENT (gauge F&G, breadth chart, COT bias)
   ============================================================ */
let breadthChartInstance = null;
async function loadSentimentTab() {
  try {
    const fng = await getFearGreed();
    if (fng) {
      const val = parseInt(fng.value);
      document.getElementById("sent_fng_num").textContent = val;
      document.getElementById("sent_fng_label").textContent = fng.value_classification;
      const gauge = document.getElementById("sent_fng_needle");
      if (gauge) gauge.style.left = val + "%";
    }
    const cgMap = await getCoinGeckoMarkets();
    const vals = Object.values(cgMap);
    const up = vals.filter(c => c.price_change_percentage_24h > 0).length;
    const down = vals.length - up;

    if (window.Chart) {
      const ctx = document.getElementById("breadthChart");
      if (ctx) {
        if (breadthChartInstance) breadthChartInstance.destroy();
        breadthChartInstance = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: ["Naik", "Turun"],
            datasets: [{ data: [up, down], backgroundColor: ["#26c281", "#f0526b"], borderWidth: 0 }]
          },
          options: { plugins: { legend: { labels: { color: "#e8ebf1" } } } }
        });
      }
    }

    const cotBody = document.getElementById("cotBody");
    if (cotBody) {
      cotBody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-dim);">Memuat COT report...</td></tr>`;
      const currencies = Object.keys(COT_CODES);
      const results = await Promise.all(currencies.map(c => getCotForCurrency(c)));
      cotBody.innerHTML = currencies.map((c, i) => {
        const r = results[i];
        if (!r) return `<tr><td>${c}</td><td colspan="2" style="color:var(--text-dim);">data tidak tersedia</td></tr>`;
        const bias = r.netNonComm >= 0 ? "NET LONG" : "NET SHORT";
        const cls = r.netNonComm >= 0 ? "win" : "loss";
        return `<tr><td>${c}</td><td class="${cls}">${bias} (${r.netNonComm.toLocaleString()})</td><td style="color:var(--text-dim);font-size:11px;">${r.date}</td></tr>`;
      }).join("");
    }
    setUpdated("sentimentUpdated", Date.now());
  } catch (e) { /* fallback diam, biarkan placeholder */ }
}

/* ============================================================
   TAB: FOREX (COT ringkas dipakai juga di sini)
   ============================================================ */
async function loadForexTab() {
  const cotBody = document.getElementById("cotBodyForex");
  if (!cotBody) return;
  cotBody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-dim);">Memuat COT report...</td></tr>`;
  try {
    const currencies = Object.keys(COT_CODES);
    const results = await Promise.all(currencies.map(c => getCotForCurrency(c)));
    cotBody.innerHTML = currencies.map((c, i) => {
      const r = results[i];
      if (!r) return `<tr><td>${c}</td><td colspan="2" style="color:var(--text-dim);">data tidak tersedia</td></tr>`;
      const bias = r.netNonComm >= 0 ? "NET LONG" : "NET SHORT";
      const cls = r.netNonComm >= 0 ? "win" : "loss";
      return `<tr><td>${c}</td><td class="${cls}">${bias} (${r.netNonComm.toLocaleString()})</td><td style="color:var(--text-dim);font-size:11px;">${r.date}</td></tr>`;
    }).join("");
    setUpdated("forexUpdated", Date.now());
  } catch (e) {
    cotBody.innerHTML = `<tr><td colspan="3" style="color:var(--red);">Gagal memuat data COT.</td></tr>`;
  }
}

/* ============================================================
   TAB: PERFORMANCE HISTORY (equity curve + WR per coin, dari performance.json)
   ============================================================ */
let equityChartInstance = null;
let wrChartInstance = null;
async function loadPerformanceTab() {
  try {
    const data = await fetchJson("./performance.json?_=" + Date.now());
    if (window.Chart) {
      const ctx1 = document.getElementById("equityChart");
      if (ctx1) {
        if (equityChartInstance) equityChartInstance.destroy();
        equityChartInstance = new Chart(ctx1, {
          type: "line",
          data: {
            labels: data.monthly_equity.map(r => r.month),
            datasets: [{ label: "Saldo (Rp)", data: data.monthly_equity.map(r => r.balance),
              borderColor: "#4f8cff", backgroundColor: "rgba(79,140,255,0.1)", fill: true, tension: 0.2 }]
          },
          options: { plugins: { legend: { labels: { color: "#e8ebf1" } } } },
            scales: { x: { ticks: { color: "#8b93a7" } }, y: { ticks: { color: "#8b93a7" } } }
        });
      }
      const ctx2 = document.getElementById("wrChart");
      if (ctx2) {
        if (wrChartInstance) wrChartInstance.destroy();
        const sorted = [...data.winrate_per_coin].sort((a, b) => b.wr - a.wr);
        wrChartInstance = new Chart(ctx2, {
          type: "bar",
          data: {
            labels: sorted.map(r => r.coin),
            datasets: [{ label: "Win Rate %", data: sorted.map(r => r.wr), backgroundColor: "#26c281" }]
          },
          options: { indexAxis: "y", plugins: { legend: { display: false } },
            scales: { x: { ticks: { color: "#8b93a7" } }, y: { ticks: { color: "#8b93a7" } } } }
        });
      }
    }
    setUpdated("performanceUpdated", Date.now());
  } catch (e) {
    const note = document.getElementById("performanceError");
    if (note) note.style.display = "block";
  }
}

/* ============================================================
   TAB: SIGNALS (existing - status.json + signals.json)
   ============================================================ */
function toWita(isoUtc) {
  if (!isoUtc) return "-";
  const d = new Date(isoUtc + "Z");
  const wita = new Date(d.getTime() + 8 * 3600 * 1000);
  return wita.toISOString().replace("T", " ").slice(0, 16) + " WITA";
}
async function loadSignalsTab() {
  try {
    const [sig, status] = await Promise.all([
      fetchJson("./signals.json?_=" + Date.now()),
      fetchJson("./status.json?_=" + Date.now())
    ]);
    document.getElementById("s_total").textContent = sig.total ?? "-";
    document.getElementById("s_wr").textContent = sig.win_rate != null ? sig.win_rate + "%" : "-";
    document.getElementById("s_pf").textContent = sig.profit_factor ?? "-";
    document.getElementById("s_open").textContent = sig.open ?? "0";
    document.getElementById("st_coins").textContent = status.coins_monitored + " coin";
    document.getElementById("st_start").textContent = status.start_date ?? "-";
    document.getElementById("st_heartbeat").textContent = toWita(status.last_check_utc);

    const tbody = document.getElementById("recentBody");
    tbody.innerHTML = "";
    (sig.recent || []).forEach(row => {
      const tr = document.createElement("tr");
      const dir = row.dir == 1 ? "BUY" : "SELL";
      const statusClass = row.status === "WIN" ? "win" : row.status === "LOSS" ? "loss" : "open";
      tr.innerHTML = `<td>${row.symbol}</td><td>${dir}</td><td>${row.entry}</td>
        <td class="${statusClass}">${row.status}</td><td>${row.R !== "" ? Number(row.R).toFixed(2) : "-"}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

/* ============================================================
   BREAKING NEWS TICKER (marquee)
   Catatan JUJUR: tidak ada API berita teks gratis+keyless+CORS-friendly
   tanpa backend (CryptoCompare & CoinGecko news sama-sama diblokir CORS
   atau butuh API key dari browser langsung). Sebagai gantinya, ticker ini
   menampilkan TOP GAINERS/LOSERS 24 jam dari data Bybit yang sudah pasti
   jalan (real, live, bukan placeholder) -- fungsinya sama (info bergerak
   cepat ala breaking ticker), sumbernya cuma beda dari "artikel berita".
   ============================================================ */
async function loadBreakingTicker() {
  const el = document.getElementById("breakingTickerInner");
  if (!el) return;
  try {
    const tickers = await getBybitTickers();
    const rows = COINS.map(sym => {
      const t = tickers[sym];
      if (!t) return null;
      return { sym: baseSymbol(sym), chg: parseFloat(t.price24hPcnt) * 100 };
    }).filter(Boolean).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 12);
    if (rows.length === 0) throw new Error("empty");
    el.innerHTML = rows.map(r => {
      const arrow = r.chg >= 0 ? "▲" : "▼";
      const cls = r.chg >= 0 ? "#7fe0b0" : "#f0c9ce";
      return `<span class="ticker-item" style="color:${cls}">${arrow} ${r.sym} ${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}% (24h)</span>`;
    }).join("");
    el.innerHTML += el.innerHTML; // duplikat biar loop mulus
  } catch (e) {
    el.innerHTML = `<span class="ticker-item">Data top mover tidak tersedia saat ini.</span>`;
  }
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  loadBreakingTicker();
  loadSignalsTab();
  loadOverviewTab();
});
