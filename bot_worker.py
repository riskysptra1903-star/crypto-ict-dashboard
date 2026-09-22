"""
Otak bot ICT Sweep+CISD (crypto futures, Bybit) -- dipindah dari crypto_ict_bot.py
supaya bisa jalan bareng web dashboard dalam 1 service (cocok utk hosting gratis).
Jalan sebagai background thread yang dipanggil dari app.py.
"""
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone

import pandas as pd
import numpy as np

from ict_sweep_cisd_final import build_ict_cisd

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

SYMBOLS = ["1000PEPEUSDT", "AAVEUSDT", "ARBUSDT", "ASTERUSDT", "BNBUSDT", "DOTUSDT", "ENAUSDT",
           "ETCUSDT", "HBARUSDT", "HYPEUSDT", "ICPUSDT", "JSTUSDT", "KASUSDT", "LINKUSDT",
           "LITUSDT", "LTCUSDT", "MNTUSDT", "MORPHOUSDT", "POLUSDT", "SHIB1000USDT", "SKYUSDT",
           "SUIUSDT", "TRXUSDT", "VVVUSDT", "WLDUSDT", "WLFIUSDT", "XLMUSDT", "XRPUSDT"]
CATEGORY = "linear"

LOOKBACK_DAYS = 5
POLL_SECONDS = 60
RR = 2.5
SL_MULT = 1.0
MAX_HOLD_MIN = 150
RISK_PCT = 1.0

SWEEP_RATIO_MIN = 0.262032
VALID_N_OPP = {2, 3}
BLOCKED_HOURS_UTC = {4, 5, 6, 7, 15, 16, 17, 18, 19}
TREND_FILTER_DAYS = 7
TREND_FILTER_THRESHOLD = 3.0

BENCHMARK_TRADES_PER_MONTH = 162
BENCHMARK_WR = 34.3
BENCHMARK_PF = 1.30

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
LOG_FILE = os.path.join(BASE_DIR, "trade_log.csv")
LOG_COLUMNS = ["id", "symbol", "dir", "entry_time", "entry", "sl", "tp",
               "sweep_ratio", "n_opp", "status", "exit_time", "exit_price", "R"]


def send_telegram(text):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("[WARN] TELEGRAM_TOKEN/CHAT_ID belum diset, skip kirim:", text[:60])
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": TELEGRAM_CHAT_ID, "text": text}).encode()
    try:
        urllib.request.urlopen(url, data=data, timeout=15)
        return True
    except Exception as e:
        print("Gagal kirim Telegram:", e)
        return False


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, default=str)


def load_log():
    if os.path.exists(LOG_FILE):
        return pd.read_csv(LOG_FILE, parse_dates=["entry_time", "exit_time"])
    return pd.DataFrame(columns=LOG_COLUMNS)


def save_log(df):
    df.to_csv(LOG_FILE, index=False)


def fetch_klines_bybit(symbol, days):
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 24 * 3600 * 1000
    all_rows = []
    cur_end = end_ms
    while cur_end > start_ms:
        url = ("https://api.bybit.com/v5/market/kline?" + urllib.parse.urlencode({
            "category": CATEGORY, "symbol": symbol, "interval": "1",
            "end": cur_end, "limit": 1000,
        }))
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        ok = False
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = json.load(r)
                ok = True
                break
            except Exception:
                time.sleep(1.5)
        if not ok:
            return None
        rows = data.get("result", {}).get("list", [])
        if not rows:
            break
        all_rows.extend(rows)
        oldest = int(rows[-1][0])
        if oldest >= cur_end:
            break
        cur_end = oldest - 1
        time.sleep(0.1)
    if not all_rows:
        return None
    df = pd.DataFrame(all_rows, columns=["time", "open", "high", "low", "close", "volume", "turnover"])
    df["time"] = pd.to_numeric(df["time"])
    df = df[(df["time"] >= start_ms) & (df["time"] <= end_ms)]
    df["datetime"] = pd.to_datetime(df["time"], unit="ms")
    df = df.set_index("datetime").sort_index()
    df = df[~df.index.duplicated(keep="first")]
    for c in ["open", "high", "low", "close"]:
        df[c] = df[c].astype(float)
    return df[["open", "high", "low", "close"]]


def fetch_klines_bybit_raw(symbol, days, interval="1"):
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 24 * 3600 * 1000
    url = ("https://api.bybit.com/v5/market/kline?" + urllib.parse.urlencode({
        "category": CATEGORY, "symbol": symbol, "interval": interval,
        "start": start_ms, "end": end_ms, "limit": 200,
    }))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except Exception:
        return None
    rows = data.get("result", {}).get("list", [])
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume", "turnover"])
    df["time"] = pd.to_numeric(df["time"])
    df["datetime"] = pd.to_datetime(df["time"], unit="ms")
    df = df.set_index("datetime").sort_index()
    return df


def get_btc_trend_pct(days=10):
    df = fetch_klines_bybit_raw("BTCUSDT", days, interval="D")
    if df is None or len(df) < 8:
        return None
    closes = df["close"].astype(float)
    now = closes.iloc[-1]
    past = closes.iloc[-8] if len(closes) >= 8 else closes.iloc[0]
    if past == 0:
        return None
    return (now / past - 1) * 100


def passes_filter(entry_ts, sweep_ratio, n_opp, direction, btc_trend_pct):
    if not (sweep_ratio >= SWEEP_RATIO_MIN):
        return False
    if n_opp not in VALID_N_OPP:
        return False
    if entry_ts.hour in BLOCKED_HOURS_UTC:
        return False
    if btc_trend_pct is not None:
        if direction == -1 and btc_trend_pct > TREND_FILTER_THRESHOLD:
            return False
        if direction == 1 and btc_trend_pct < -TREND_FILTER_THRESHOLD:
            return False
    return True


def fmt_price(val):
    if val >= 100:
        return f"{val:,.2f}"
    elif val >= 1:
        return f"{val:.4f}"
    else:
        return f"{val:.6f}"


def find_signals(df_m1, btc_trend_pct):
    df_out, meta = build_ict_cisd(df_m1, window_minutes=90)
    if not meta:
        return []
    signals = []
    for entry_ts, m in meta.items():
        if entry_ts not in df_out.index:
            continue
        pos = df_out.index.get_loc(entry_ts)
        if pos == 0:
            continue
        sig_val = None
        for k in range(pos, max(pos - 3, -1), -1):
            if df_out["signal"].iloc[k] != 0:
                sig_val = df_out["signal"].iloc[k]
                break
        if sig_val is None:
            continue
        if not passes_filter(entry_ts, m["sweep_ratio"], m["n_opp"], int(sig_val), btc_trend_pct):
            continue
        entry_price = df_out["open"].iloc[pos]
        risk = SL_MULT * df_out["atr14"].iloc[pos - 1]
        if risk <= 0 or np.isnan(risk):
            continue
        if sig_val == 1:
            sl = entry_price - risk
            tp = entry_price + RR * risk
        else:
            sl = entry_price + risk
            tp = entry_price - RR * risk
        signals.append(dict(
            entry_time=entry_ts, dir=int(sig_val), entry=entry_price, sl=sl, tp=tp,
            sweep_ratio=m["sweep_ratio"], n_opp=m["n_opp"],
        ))
    return signals


def update_open_trades(log_df, symbol, df_m1):
    open_mask = (log_df["symbol"] == symbol) & (log_df["status"] == "OPEN")
    for idx in log_df[open_mask].index:
        row = log_df.loc[idx]
        entry_time = pd.Timestamp(row["entry_time"])
        bars_after = df_m1[df_m1.index > entry_time]
        if bars_after.empty:
            continue
        direction = row["dir"]
        sl, tp = row["sl"], row["tp"]
        exit_price, exit_time, r_val = None, None, None
        for ts, bar in bars_after.iterrows():
            hit_sl = (bar["low"] <= sl) if direction == 1 else (bar["high"] >= sl)
            hit_tp = (bar["high"] >= tp) if direction == 1 else (bar["low"] <= tp)
            elapsed_min = (ts - entry_time).total_seconds() / 60
            if hit_sl:
                exit_price, exit_time = sl, ts
                r_val = -1.0
                break
            elif hit_tp:
                exit_price, exit_time = tp, ts
                r_val = RR
                break
            elif elapsed_min >= MAX_HOLD_MIN:
                exit_price, exit_time = bar["close"], ts
                risk = abs(row["entry"] - sl)
                pnl = (exit_price - row["entry"]) if direction == 1 else (row["entry"] - exit_price)
                r_val = pnl / risk if risk > 0 else 0.0
                break
        if exit_price is not None:
            hasil = "WIN" if r_val > 0 else "LOSS"
            log_df.loc[idx, "status"] = hasil
            log_df.loc[idx, "exit_time"] = exit_time
            log_df.loc[idx, "exit_price"] = exit_price
            log_df.loc[idx, "R"] = r_val
            emoji = "TP KENA" if hasil == "WIN" else "SL KENA"
            send_telegram(
                f"[{emoji}] {symbol}\n"
                f"Entry: {fmt_price(row['entry'])} ({'BUY' if direction == 1 else 'SELL'})\n"
                f"Exit: {fmt_price(exit_price)} @ {exit_time + pd.Timedelta(hours=8)} (WITA)\n"
                f"Hasil: {r_val:+.2f}R"
            )
    return log_df


def main_once(state, verbose=True):
    log_df = load_log()
    btc_trend_pct = get_btc_trend_pct()
    if verbose:
        print(f"BTC trend 7 hari: {btc_trend_pct:+.2f}%" if btc_trend_pct is not None else "BTC trend: gagal ambil")

    for symbol in SYMBOLS:
        try:
            df_m1 = fetch_klines_bybit(symbol, LOOKBACK_DAYS)
        except Exception as e:
            print(f"[{symbol}] fetch error: {e}")
            continue
        if df_m1 is None or len(df_m1) < 3000:
            continue

        log_df = update_open_trades(log_df, symbol, df_m1)

        try:
            signals = find_signals(df_m1, btc_trend_pct)
        except Exception as e:
            print(f"[{symbol}] analisis error: {e}")
            continue

        if not signals:
            continue

        signals.sort(key=lambda s: s["entry_time"])
        last_seen_str = state.get(symbol)
        last_seen = pd.Timestamp(last_seen_str) if last_seen_str else None

        if last_seen is None:
            newest = signals[-1]
            state[symbol] = str(newest["entry_time"])
            print(f"[{symbol}] baseline diset ke {newest['entry_time']}")
            continue

        new_sigs = [s for s in signals if s["entry_time"] > last_seen]
        for sig in new_sigs:
            arah = "BUY" if sig["dir"] == 1 else "SELL"
            harga_sekarang = df_m1["close"].iloc[-1]
            lag_min = (df_m1.index[-1] - sig["entry_time"]).total_seconds() / 60
            risk_pct_of_sl = abs(sig["entry"] - sig["sl"]) / sig["entry"] * 100
            msg = (
                f"[SINYAL {arah}] {symbol} (crypto FUTURES) -- MARKET ORDER, bukan limit\n"
                f"Waktu entry acuan (WITA): {sig['entry_time'] + pd.Timedelta(hours=8)} (~{lag_min:.0f} menit lalu)\n"
                f"Entry acuan: {fmt_price(sig['entry'])}\n"
                f"Harga SEKARANG: {fmt_price(harga_sekarang)}\n"
                f"SL: {fmt_price(sig['sl'])} (jarak {risk_pct_of_sl:.2f}%)\n"
                f"TP: {fmt_price(sig['tp'])} (RR 1:{RR})\n"
                f"Risiko posisi: {RISK_PCT:.0f}% dari saldo saat ini\n"
                f"sweep_ratio={sig['sweep_ratio']:.3f}  n_opp={sig['n_opp']}"
            )
            print(msg)
            send_telegram(msg)
            state[symbol] = str(sig["entry_time"])
            new_row = {
                "symbol": symbol, "dir": sig["dir"], "entry_time": sig["entry_time"],
                "entry": sig["entry"], "sl": sig["sl"], "tp": sig["tp"],
                "sweep_ratio": sig["sweep_ratio"], "n_opp": sig["n_opp"],
                "status": "OPEN", "exit_time": None, "exit_price": None, "R": None,
            }
            log_df = pd.concat([log_df, pd.DataFrame([new_row])], ignore_index=True)

    save_log(log_df)
    save_state(state)
    return state


def maybe_heartbeat(state):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if state.get("_heartbeat_date") == today:
        return
    log_df = load_log()
    n_open = (log_df["status"] == "OPEN").sum() if len(log_df) else 0
    msg = (
        f"[STATUS] Bot Crypto ICT Sweep+CISD sedang RUNNING (di server, bukan laptop lagi)\n"
        f"Waktu cek (WITA): {(datetime.now(timezone.utc) + pd.Timedelta(hours=8)).strftime('%Y-%m-%d %H:%M')}\n"
        f"Pair dipantau: {len(SYMBOLS)} coin\n"
        f"Trade sedang OPEN: {n_open}\n"
        f"Ekspektasi backtest: ~{BENCHMARK_TRADES_PER_MONTH} trade/bulan, WR {BENCHMARK_WR}%, PF {BENCHMARK_PF}"
    )
    send_telegram(msg)
    state["_heartbeat_date"] = today
    save_state(state)


def run_loop():
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("[FATAL] TELEGRAM_TOKEN / TELEGRAM_CHAT_ID belum diset di environment variable!")
    state = load_state()
    print(f"Mulai monitoring {len(SYMBOLS)} coin tiap {POLL_SECONDS} detik...")
    maybe_heartbeat(state)
    while True:
        try:
            state = main_once(state)
            maybe_heartbeat(state)
        except Exception as e:
            print("[ERROR loop]", e)
        time.sleep(POLL_SECONDS)
