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
   UTIL: count-up animation untuk angka penting
   ============================================================ */
function countUpText(el, finalText, durationMs = 700) {
  const match = finalText.match(/-?[\d.,]+/);
  if (!match) { el.textContent = finalText; return; }
  const numStr = match[0].replace(/,/g, "");
  const finalNum = parseFloat(numStr);
  if (isNaN(finalNum)) { el.textContent = finalText; return; }
  const prefix = finalText.slice(0, match.index);
  const suffix = finalText.slice(match.index + match[0].length);
  const decimals = (numStr.split(".")[1] || "").length;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const cur = finalNum * eased;
    el.textContent = prefix + cur.toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = finalText;
  }
  requestAnimationFrame(step);
}

/* ============================================================
   OVERVIEW: strip pasar cepat, event minggu ini, berita, ringkasan bot
   ============================================================ */
async function loadOverviewStrip() {
  const row = document.getElementById("stripRow");
  if (!row) return;
  try {
    const tickers = await getBybitTickers();
    const btc = tickers["BTCUSDT"];
    const items = [
      { lbl: "BTC", val: btc ? "$" + fmtCompact(parseFloat(btc.lastPrice)) : "-", chg: btc ? parseFloat(btc.price24hPcnt) * 100 : null },
    ];
    row.innerHTML = items.map(i => `
      <div class="strip-item">
        <div class="sv ${i.chg >= 0 ? "win" : "loss"}">${i.val}</div>
        <div class="sl">${i.lbl} ${i.chg !== null ? (i.chg >= 0 ? "+" : "") + i.chg.toFixed(2) + "%" : ""}</div>
      </div>`).join("") + `
      <div class="strip-item"><div class="sv" style="color:var(--text-dim);font-size:11px;">Lihat live di tab<br>Forex & Commodities</div><div class="sl">DXY · XAUUSD · S&P 500</div></div>`;
    setUpdated("stripUpdated", Date.now());
  } catch (e) {
    row.innerHTML = `<div class="strip-item"><div class="sv" style="color:var(--text-dim);">tidak tersedia</div></div>`;
  }
}

// NFP = Jumat pertama tiap bulan (aturan resmi, selalu benar secara definisi)
function getFirstFridayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 1));
  const day = d.getUTCDay();
  const offset = (5 - day + 7) % 7;
  d.setUTCDate(1 + offset);
  return d;
}
function buildKnownEvents() {
  const now = new Date();
  const events = [];
  for (let m = 0; m < 3; m++) {
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth() + m;
    const nfp = getFirstFridayOfMonth(y, mo);
    events.push({ date: nfp, name: "Non-Farm Payroll (NFP) AS", note: "Selalu Jumat pertama tiap bulan — historically bikin USD & Gold bergerak besar." });
  }
  events.push({ date: null, name: "FOMC Rate Decision", note: "Jadwal FOMC diumumkan resmi jauh hari oleh The Fed — cek tanggal PASTI di tab Calendar, biasanya ~8x/tahun.", approx: true });
  events.push({ date: null, name: "CPI AS (Inflasi)", note: "Biasanya dirilis sekitar minggu ke-2 tiap bulan — cek tanggal PASTI di tab Calendar.", approx: true });
  return events.filter(e => e.date === null || e.date >= new Date(now.getTime() - 86400000)).sort((a, b) => (a.date || new Date(2099, 0)) - (b.date || new Date(2099, 0)));
}
function loadWeekAhead() {
  const el = document.getElementById("weekAheadList");
  if (!el) return;
  const events = buildKnownEvents().slice(0, 5);
  el.innerHTML = events.map(e => {
    const dateStr = e.date ? e.date.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "Tanggal bervariasi";
    return `<div class="mini-row"><span><b>${dateStr}</b> — ${e.name}${e.approx ? " *" : ""}</span></div>
      <div style="font-size:11.5px;color:var(--text-dim);padding-bottom:8px;">${e.note}</div>`;
  }).join("");
}
async function loadOverviewEventsPreview() {
  const el = document.getElementById("ov_events");
  if (!el) return;
  const events = buildKnownEvents().slice(0, 3);
  el.innerHTML = events.map(e => {
    const dateStr = e.date ? e.date.toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }) : "~bulan ini";
    return `<div class="mini-row"><span>${e.name}</span><span style="color:var(--text-dim);">${dateStr}</span></div>`;
  }).join("");
}

async function loadOverviewNewsPreview() {
  const el = document.getElementById("ov_news");
  if (!el) return;
  try {
    const feed = "https://cointelegraph.com/rss";
    const data = await fetchJson("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feed));
    const items = (data.items || []).slice(0, 3);
    if (items.length === 0) throw new Error("empty");
    el.innerHTML = items.map(n => `<div class="mini-row"><span>${n.title}</span></div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="mini-row"><span style="color:var(--text-dim);">Berita tidak tersedia saat ini.</span></div>`;
  }
}

async function loadOverviewBotSummary() {
  const el = document.getElementById("ov_bot_summary");
  if (!el) return;
  try {
    const sig = await fetchJson("./signals.json?_=" + Date.now());
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = (sig.recent || []).filter(r => (r.entry_time || "").slice(0, 10) === today).length;
    el.innerHTML = `
      <div class="mini-row"><span>Sinyal hari ini</span><span class="rv">${todayCount}</span></div>
      <div class="mini-row"><span>Win Rate keseluruhan</span><span class="rv">${sig.win_rate != null ? sig.win_rate + "%" : "-"}</span></div>
      <div class="mini-row"><span>Profit Factor</span><span class="rv">${sig.profit_factor ?? "-"}</span></div>
      <div class="mini-row"><span>Trade sedang open</span><span class="rv">${sig.open ?? 0}</span></div>`;
  } catch (e) {
    el.innerHTML = `<div class="mini-row"><span style="color:var(--text-dim);">Data bot tidak tersedia.</span></div>`;
  }
}

/* ============================================================
   NEWS: RSS multi-sumber via rss2json (keyless, free tier)
   ============================================================ */
const RSS_SOURCES = {
  rss_coindesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  rss_cointelegraph: "https://cointelegraph.com/rss",
  rss_forexlive: "https://www.forexlive.com/feed/news",
  rss_marketwatch: "https://www.marketwatch.com/rss/topstories",
  rss_cnbc: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
};
async function loadRssFeeds() {
  for (const [elId, feedUrl] of Object.entries(RSS_SOURCES)) {
    const el = document.getElementById(elId);
    if (!el || el.dataset.loaded) continue;
    try {
      const data = await fetchJson("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feedUrl));
      const items = (data.items || []).slice(0, 6);
      if (items.length === 0) throw new Error("empty");
      el.innerHTML = items.map(n => `<div class="mini-row"><a href="${n.link}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;">${n.title}</a></div>`).join("");
      el.dataset.loaded = "1";
    } catch (e) {
      el.innerHTML = `<div class="mini-row"><span style="color:var(--text-dim);">Sumber ini tidak tersedia saat ini.</span></div>`;
    }
  }
}

/* ============================================================
   CALENDAR: tabel referensi dampak historis (statis)
   ============================================================ */
const HISTORICAL_IMPACT = [
  ["Non-Farm Payroll (NFP)", "Jauh di atas ekspektasi → USD cenderung menguat tajam, Gold & crypto tertekan sesaat. Di bawah ekspektasi → kebalikannya."],
  ["CPI / Inflasi", "Di atas ekspektasi → DXY naik, Gold & crypto cenderung tertekan sesaat. Di bawah ekspektasi → kebalikannya."],
  ["FOMC / Interest Rate Decision", "Nada hawkish/naik bunga → USD menguat, Gold & crypto tertekan. Nada dovish/pause → kebalikannya. Kejutan vs ekspektasi pasar yang paling menggerakkan harga."],
  ["GDP", "Di atas ekspektasi → mata uang terkait cenderung menguat jangka pendek."],
  ["PMI (Manufacturing/Services)", "Di atas 50 & naik dari sebelumnya → sentimen risk-on, mendukung mata uang & saham terkait."],
  ["Unemployment Rate", "Naik dari ekspektasi → mata uang terkait melemah."],
  ["Retail Sales", "Di atas ekspektasi → mata uang menguat, sinyal konsumsi kuat."],
];
function renderHistoricalImpact() {
  const el = document.getElementById("historicalImpactBody");
  if (!el || el.dataset.loaded) return;
  el.innerHTML = HISTORICAL_IMPACT.map(([name, note]) => `<tr><td style="white-space:normal;font-weight:600;">${name}</td><td style="white-space:normal;color:var(--text-dim);">${note}</td></tr>`).join("");
  el.dataset.loaded = "1";
}

/* ============================================================
   BERITA FUNDAMENTAL PER COIN WATCHLIST
   Cocokkan judul RSS asli (CoinDesk + CoinTelegraph) dengan nama coin --
   APA ADANYA, tanpa skor akurasi/prediksi apapun (fabrikasi dilarang).
   ============================================================ */
async function loadFundamentalNews() {
  const el = document.getElementById("fundamentalNewsBody");
  if (!el) return;
  try {
    const feeds = ["https://www.coindesk.com/arc/outboundfeeds/rss/", "https://cointelegraph.com/rss"];
    const results = await Promise.all(feeds.map(f =>
      fetchJson("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(f)).catch(() => null)
    ));
    const allItems = [];
    results.forEach(r => { if (r && r.items) allItems.push(...r.items); });

    const matches = [];
    COINS.forEach(sym => {
      const base = baseSymbol(sym);
      const re = new RegExp("\\b" + base + "\\b", "i");
      allItems.forEach(item => {
        if (re.test(item.title)) matches.push({ coin: base, title: item.title, link: item.link, date: item.pubDate });
      });
    });

    if (matches.length === 0) {
      el.innerHTML = `<div class="mini-row"><span style="color:var(--text-dim);">Belum ada berita terbaru dari CoinDesk/CoinTelegraph yang menyebut coin di watchlist ini secara spesifik.</span></div>`;
    } else {
      el.innerHTML = matches.slice(0, 15).map(m => `
        <div class="mini-row">
          <span><b>${m.coin}</b> — <a href="${m.link}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;">${m.title}</a></span>
        </div>`).join("");
    }
    setUpdated("fundamentalUpdated", Date.now());
  } catch (e) {
    el.innerHTML = `<div class="mini-row"><span style="color:var(--red);">Gagal memuat berita fundamental.</span></div>`;
  }
}

/* ============================================================
   TRENDING COINS (CoinGecko /search/trending)
   ============================================================ */
async function loadTrendingCoins() {
  const tbody = document.getElementById("trendingTableBody");
  if (!tbody) return;
  try {
    const data = await fetchJson(`${CG_BASE}/search/trending`);
    const coins = (data.coins || []).slice(0, 10).map(c => c.item);
    tbody.innerHTML = coins.map(c => `
      <tr>
        <td>${c.symbol.toUpperCase()}</td>
        <td>${c.data && c.data.price ? "$" + fmtNum(c.data.price, c.data.price < 1 ? 6 : 2) : "-"}</td>
        <td class="${c.data && c.data.price_change_percentage_24h && c.data.price_change_percentage_24h.usd >= 0 ? "win" : "loss"}">
          ${c.data && c.data.price_change_percentage_24h ? fmtNum(c.data.price_change_percentage_24h.usd, 2) + "%" : "-"}
        </td>
        <td>${c.data && c.data.total_volume ? c.data.total_volume : "-"}</td>
      </tr>`).join("");
    setUpdated("trendingUpdated", Date.now());
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--red);text-align:center;">Gagal memuat trending coins.</td></tr>`;
  }
}

/* ============================================================
   KALKULATOR RISIKO
   ============================================================ */
let rcDir = 1;
function setRcDir(dir) {
  rcDir = dir;
  document.getElementById("rc_dir_long").className = dir === 1 ? "sel-buy" : "";
  document.getElementById("rc_dir_short").className = dir === -1 ? "sel-sell" : "";
  calcRisk();
}
function calcRisk() {
  const balance = parseFloat(document.getElementById("rc_balance").value) || 0;
  const riskPct = parseFloat(document.getElementById("rc_risk").value) || 0;
  const entry = parseFloat(document.getElementById("rc_entry").value) || 0;
  const sl = parseFloat(document.getElementById("rc_sl").value) || 0;
  const leverage = parseFloat(document.getElementById("rc_leverage").value) || 1;

  if (!entry || !sl || entry === sl) {
    ["rc_out_risk", "rc_out_sldist", "rc_out_possize", "rc_out_margin", "rc_out_liq", "rc_out_safety"].forEach(id => document.getElementById(id).textContent = "-");
    return;
  }
  const riskRp = balance * (riskPct / 100);
  const slDistPct = Math.abs(entry - sl) / entry * 100;
  const posSize = riskRp / (slDistPct / 100);
  const margin = posSize / leverage;
  const MMR = 0.005;
  let liq;
  if (rcDir === 1) liq = entry * (1 - 1 / leverage + MMR);
  else liq = entry * (1 + 1 / leverage - MMR);

  const slBeforeLiq = rcDir === 1 ? sl > liq : sl < liq;

  document.getElementById("rc_out_risk").textContent = "Rp" + riskRp.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  document.getElementById("rc_out_sldist").textContent = slDistPct.toFixed(3) + "%";
  document.getElementById("rc_out_possize").textContent = "Rp" + posSize.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  document.getElementById("rc_out_margin").textContent = "Rp" + margin.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  document.getElementById("rc_out_liq").textContent = liq.toFixed(entry < 1 ? 6 : 2);
  const safetyEl = document.getElementById("rc_out_safety");
  if (slBeforeLiq) {
    safetyEl.textContent = "AMAN — SL kena duluan sebelum liquidation";
    safetyEl.style.color = "var(--green)";
  } else {
    safetyEl.textContent = "BAHAYA — Liquidation bisa kena SEBELUM SL! Turunkan leverage.";
    safetyEl.style.color = "var(--red)";
  }
}
["rc_balance", "rc_risk", "rc_entry", "rc_sl", "rc_leverage"].forEach(id => {
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", calcRisk);
  });
});

/* ============================================================
   JURNAL TRADING (localStorage, tanpa backend)
   ============================================================ */
let jrDir = 1;
function setJrDir(dir) {
  jrDir = dir;
  document.getElementById("jr_dir_buy").className = dir === 1 ? "sel-buy" : "";
  document.getElementById("jr_dir_sell").className = dir === -1 ? "sel-sell" : "";
}
function loadJournalData() {
  try { return JSON.parse(localStorage.getItem("trading_journal") || "[]"); } catch (e) { return []; }
}
function saveJournalEntry() {
  const entry = {
    date: document.getElementById("jr_date").value || new Date().toISOString().slice(0, 10),
    coin: document.getElementById("jr_coin").value || "-",
    dir: jrDir,
    hasil: document.getElementById("jr_hasil").value,
    entryBot: parseFloat(document.getElementById("jr_entry_bot").value) || null,
    entryActual: parseFloat(document.getElementById("jr_entry_actual").value) || null,
    slBot: parseFloat(document.getElementById("jr_sl_bot").value) || null,
    exitActual: parseFloat(document.getElementById("jr_exit_actual").value) || null,
    alasan: document.getElementById("jr_alasan").value || "",
  };
  const data = loadJournalData();
  data.unshift(entry);
  localStorage.setItem("trading_journal", JSON.stringify(data));
  ["jr_coin", "jr_entry_bot", "jr_entry_actual", "jr_sl_bot", "jr_exit_actual", "jr_alasan"].forEach(id => document.getElementById(id).value = "");
  renderJournal();
}
function deleteJournalEntry(idx) {
  const data = loadJournalData();
  data.splice(idx, 1);
  localStorage.setItem("trading_journal", JSON.stringify(data));
  renderJournal();
}
function renderJournal() {
  const tbody = document.getElementById("jr_table_body");
  const statsEl = document.getElementById("jr_stats");
  if (!tbody) return;
  const data = loadJournalData();
  const wins = data.filter(d => d.hasil === "WIN").length;
  const total = data.length;
  statsEl.innerHTML = `
    <div class="stat-box"><div class="val">${total}</div><div class="lbl">Total Trade Manual</div></div>
    <div class="stat-box"><div class="val">${total > 0 ? (wins / total * 100).toFixed(1) + "%" : "-"}</div><div class="lbl">Win Rate Aktual</div></div>`;
  tbody.innerHTML = data.map((d, i) => {
    const gap = (d.entryBot && d.entryActual) ? ((d.entryActual - d.entryBot) / d.entryBot * 100).toFixed(3) + "%" : "-";
    const hasilClass = d.hasil === "WIN" ? "win" : d.hasil === "LOSS" ? "loss" : "open";
    return `<tr>
      <td>${d.date}</td><td>${d.coin}</td><td>${d.dir === 1 ? "BUY" : "SELL"}</td>
      <td>${d.entryBot ?? "-"}</td><td>${d.entryActual ?? "-"}</td><td>${gap}</td>
      <td class="${hasilClass}">${d.hasil}</td>
      <td><button class="link-btn" onclick="deleteJournalEntry(${i})">Hapus</button></td>
    </tr>`;
  }).join("");
}

/* ============================================================
   LIGHTWEIGHT CHARTS: candlestick + overlay sinyal (Entry/SL/TP)
   + overlay indikator ICT Sweep+CISD (Swing High/Low + sweep event)
   ============================================================ */
let lwChart = null, lwSeries = null, lwCurrentSymbol = "BYBIT:1000PEPEUSDT.P", lwCurrentInterval = "1";
let lwPriceLines = [];
function lwClearPriceLines() {
  lwPriceLines.forEach(pl => { try { lwSeries.removePriceLine(pl); } catch (e) {} });
  lwPriceLines = [];
}
async function lwFetchKlines(symbolBybit, interval) {
  const limit = 300;
  const data = await fetchJson(`${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbolBybit}&interval=${interval}&limit=${limit}`);
  const list = (data.result && data.result.list) || [];
  return list.map(r => ({
    time: Math.floor(parseInt(r[0]) / 1000),
    open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]),
  })).reverse();
}
async function lwOverlaySignals(symbolBybit) {
  const markers = [];
  try {
    const sig = await fetchJson("./signals.json?_=" + Date.now());
    const trades = (sig.recent || []).filter(r => r.symbol === symbolBybit);
    trades.forEach(tr => {
      const priceLines = [{ price: parseFloat(tr.entry), color: "#f0b429", title: "Entry" }];
      if (tr.sl) priceLines.push({ price: parseFloat(tr.sl), color: "#f0526b", title: "SL" });
      if (tr.tp) priceLines.push({ price: parseFloat(tr.tp), color: "#26c281", title: "TP" });
      priceLines.forEach(pl => {
        lwPriceLines.push(lwSeries.createPriceLine({ price: pl.price, color: pl.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: pl.title }));
      });
      markers.push({
        time: Math.floor(new Date(tr.entry_time.replace(" ", "T") + "Z").getTime() / 1000),
        position: tr.dir == 1 ? "belowBar" : "aboveBar",
        color: tr.dir == 1 ? "#26c281" : "#f0526b",
        shape: tr.dir == 1 ? "arrowUp" : "arrowDown",
        text: tr.dir == 1 ? "BUY" : "SELL",
      });
    });
  } catch (e) { /* diamkan, chart tetap tampil tanpa overlay sinyal */ }
  return markers;
}

// ---- Port logika indikator ICT Sweep+CISD (dari ict_sweep_cisd_final.py) ke JS ----
function detectFractalSwingsJs(highs, lows, n = 2) {
  const len = highs.length;
  const sh = new Array(len).fill(null);
  const sl = new Array(len).fill(null);
  for (let i = n; i < len - n; i++) {
    const wh = highs.slice(i - n, i + n + 1);
    const wl = lows.slice(i - n, i + n + 1);
    const maxH = Math.max(...wh), minL = Math.min(...wl);
    if (highs[i] === maxH && wh.indexOf(maxH) === n) sh[i + n] = highs[i];
    if (lows[i] === minL && wl.indexOf(minL) === n) sl[i + n] = lows[i];
  }
  return { sh, sl };
}
function findSweepEventsJs(h1Bars) {
  const highs = h1Bars.map(b => b.high), lows = h1Bars.map(b => b.low), closes = h1Bars.map(b => b.close);
  const { sh, sl } = detectFractalSwingsJs(highs, lows, 2);
  let lastSH = null, lastSL = null;
  const events = [];
  const startIdx = Math.min(30, h1Bars.length - 1);
  for (let i = startIdx; i < h1Bars.length; i++) {
    if (sh[i] !== null) lastSH = sh[i];
    if (sl[i] !== null) lastSL = sl[i];
    if (lastSH !== null && highs[i] > lastSH && closes[i] < lastSH) {
      events.push({ time: h1Bars[i].time, dir: -1, level: lastSH });
    } else if (lastSL !== null && lows[i] < lastSL && closes[i] > lastSL) {
      events.push({ time: h1Bars[i].time, dir: 1, level: lastSL });
    }
  }
  return { events, lastSH, lastSL };
}
async function lwOverlayIndicator(symbolBybit) {
  const markers = [];
  try {
    const data = await fetchJson(`${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbolBybit}&interval=60&limit=200`);
    const list = (data.result && data.result.list) || [];
    const h1Bars = list.map(r => ({
      time: Math.floor(parseInt(r[0]) / 1000), open: parseFloat(r[1]),
      high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]),
    })).reverse();
    if (h1Bars.length < 35) return markers;
    const { events, lastSH, lastSL } = findSweepEventsJs(h1Bars);

    if (lastSH) lwPriceLines.push(lwSeries.createPriceLine({ price: lastSH, color: "#8b93a7", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: "Swing High" }));
    if (lastSL) lwPriceLines.push(lwSeries.createPriceLine({ price: lastSL, color: "#8b93a7", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: "Swing Low" }));

    const indStatus = document.getElementById("chartIndicatorStatus");
    if (indStatus) {
      indStatus.innerHTML = `Swing High H1: <b>${lastSH ? fmtNum(lastSH, lastSH < 1 ? 6 : 2) : "-"}</b> &nbsp;|&nbsp; Swing Low H1: <b>${lastSL ? fmtNum(lastSL, lastSL < 1 ? 6 : 2) : "-"}</b> &nbsp;|&nbsp; Sweep event terdeteksi (200 candle H1 terakhir): <b>${events.length}</b>`;
    }

    events.slice(-30).forEach(e => {
      markers.push({
        time: e.time,
        position: e.dir === -1 ? "aboveBar" : "belowBar",
        color: "#8b93a7",
        shape: e.dir === -1 ? "arrowDown" : "arrowUp",
        text: "Sweep",
      });
    });
  } catch (e) { /* diamkan, chart tetap tampil tanpa overlay indikator */ }
  return markers;
}

async function lwLoadSymbol(tvSymbol) {
  lwCurrentSymbol = tvSymbol;
  const bybitSym = tvSymbol.replace("BYBIT:", "").replace(".P", "");
  if (!lwSeries) return;
  try {
    lwClearPriceLines();
    const klines = await lwFetchKlines(bybitSym, lwCurrentInterval);
    lwSeries.setData(klines);
    const [signalMarkers, indicatorMarkers] = await Promise.all([
      lwOverlaySignals(bybitSym),
      lwOverlayIndicator(bybitSym),
    ]);
    const allMarkers = [...indicatorMarkers, ...signalMarkers].sort((a, b) => a.time - b.time);
    if (allMarkers.length) lwSeries.setMarkers(allMarkers);
    lwChart.timeScale().fitContent();
  } catch (e) {
    console.error("gagal load chart", e);
  }
}
function lwLoadInterval(tf) {
  lwCurrentInterval = tf;
  lwLoadSymbol(lwCurrentSymbol);
}
function lwResize() {
  if (!lwChart) return;
  const container = document.getElementById("lwChartContainer");
  const isFull = container.classList.contains("fullscreen-chart");
  const h = isFull ? window.innerHeight - 130 : 480;
  document.getElementById("lwChart").style.height = h + "px";
  lwChart.resize(container.clientWidth - (isFull ? 20 : 0), h);
}
window.lwLoadSymbol = lwLoadSymbol;
window.lwLoadInterval = lwLoadInterval;
window.lwResize = lwResize;
window.initLwChart = function () {
  if (lwChart) { lwResize(); return; }
  if (!window.LightweightCharts) { setTimeout(window.initLwChart, 200); return; }
  const el = document.getElementById("lwChart");
  lwChart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b93a7" },
    grid: { vertLines: { color: "#1a1f2b" }, horzLines: { color: "#1a1f2b" } },
    width: el.clientWidth, height: 480,
    timeScale: { timeVisible: true, secondsVisible: false },
  });
  lwSeries = lwChart.addCandlestickSeries({
    upColor: "#26c281", downColor: "#f0526b", borderVisible: false,
    wickUpColor: "#26c281", wickDownColor: "#f0526b",
  });
  const picker = document.getElementById("symbolPicker");
  lwLoadSymbol(picker.value);
  window.addEventListener("resize", lwResize);
};

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  loadBreakingTicker();
  loadSignalsTab();
  loadOverviewTab();
  loadOverviewStrip();
  loadOverviewEventsPreview();
  loadOverviewNewsPreview();
  loadOverviewBotSummary();
  setJrDir(1);
  renderJournal();
  calcRisk();
});
