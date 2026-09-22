"""
ICT Sweep + CISD Strategy - Final Version (disalin dari riset asli, TIDAK diubah)
===========================================
Hasil riset: PF 1.58, WR 39%, RR 1:2.5, pair GBPUSD + XAUUSD
Data: M1, Juni-September 2026 (3 bulan)
"""
import pandas as pd
import numpy as np


def load(path):
    df = pd.read_csv(path, sep='\t')
    df.columns = [c.strip('<>').lower() for c in df.columns]
    df['datetime'] = pd.to_datetime(df['date'] + ' ' + df['time'], format='%Y.%m.%d %H:%M:%S')
    df = df.set_index('datetime').sort_index()
    return df[['open', 'high', 'low', 'close', 'spread']].astype(float, errors='ignore')


def detect_fractal_swings(high, low, fractal_n=2):
    n = len(high)
    sh = np.full(n, np.nan)
    sl = np.full(n, np.nan)
    for i in range(fractal_n, n - fractal_n):
        wh = high[i - fractal_n:i + fractal_n + 1]
        wl = low[i - fractal_n:i + fractal_n + 1]
        if high[i] == wh.max() and np.argmax(wh) == fractal_n:
            sh[i + fractal_n] = high[i]
        if low[i] == wl.min() and np.argmin(wl) == fractal_n:
            sl[i + fractal_n] = low[i]
    return sh, sl


def h1_sweep_events(df_h1, fractal_n=2):
    high = df_h1['high'].values
    low = df_h1['low'].values
    close = df_h1['close'].values
    sh, sl = detect_fractal_swings(high, low, fractal_n)
    n = len(df_h1)
    events = []
    last_sh = np.nan
    last_sl = np.nan
    for i in range(30, n):
        if not np.isnan(sh[i]):
            last_sh = sh[i]
        if not np.isnan(sl[i]):
            last_sl = sl[i]
        if not np.isnan(last_sh) and high[i] > last_sh and close[i] < last_sh:
            events.append((df_h1.index[i], -1, high[i] - last_sh, last_sh))
        elif not np.isnan(last_sl) and low[i] < last_sl and close[i] > last_sl:
            events.append((df_h1.index[i], 1, last_sl - low[i], last_sl))
    return events


def build_ict_cisd(df_m1, window_minutes=90, buffer_mult=1.0):
    df_h1 = df_m1['open'].resample('1h').first().to_frame('open')
    df_h1['high'] = df_m1['high'].resample('1h').max()
    df_h1['low'] = df_m1['low'].resample('1h').min()
    df_h1['close'] = df_m1['close'].resample('1h').last()
    df_h1 = df_h1.dropna()

    events = h1_sweep_events(df_h1)
    bar_range = df_m1['high'] - df_m1['low']
    avg_range = bar_range.rolling(20).mean()
    atr_h1 = (df_h1['high'] - df_h1['low']).rolling(14).mean()
    idx = df_m1.index

    signal = pd.Series(0, index=df_m1.index)
    meta = {}
    for t_h1, direction, sweep_extent, swept_level in events:
        start = t_h1 + pd.Timedelta(hours=1)
        end = start + pd.Timedelta(minutes=window_minutes)
        window = df_m1.loc[start:end]
        if len(window) == 0:
            continue
        ref_open = None
        n_opp = 0
        for ts, row in window.iterrows():
            is_opp = (row['close'] < row['open']) if direction == 1 else (row['close'] > row['open'])
            if is_opp:
                ref_open = row['open']
                n_opp += 1
                continue
            if ref_open is not None:
                crossed = (row['close'] > ref_open) if direction == 1 else (row['close'] < ref_open)
                if crossed:
                    signal.loc[ts] = direction
                    pos = idx.get_loc(ts)
                    entry_ts = idx[pos + 1] if pos + 1 < len(idx) else ts
                    h1_atr = atr_h1.get(t_h1, np.nan)
                    sweep_ratio = sweep_extent / h1_atr if h1_atr and h1_atr > 0 else np.nan
                    meta[entry_ts] = dict(
                        sweep_ratio=sweep_ratio, n_opp=n_opp,
                        sweep_h1_time=t_h1, swept_level=swept_level, cisd_time=ts,
                    )
                    break

    df_m1 = df_m1.copy()
    df_m1['signal'] = signal.values
    df_m1['atr14'] = buffer_mult * avg_range
    return df_m1, meta


def run_backtest(df, point, sl_mult=1.0, rr=2.5, max_hold=150):
    df = df.dropna(subset=['atr14']).copy()
    n = len(df)
    op = df['open'].values
    hi = df['high'].values
    lo = df['low'].values
    cl = df['close'].values
    atrv = df['atr14'].values
    sig = df['signal'].values

    trades = []
    in_pos = False
    for i in range(1, n - 1):
        if not in_pos:
            s = sig[i - 1]
            if s == 0:
                continue
            entry = op[i]
            risk = sl_mult * atrv[i - 1]
            if risk <= 0 or np.isnan(risk):
                continue
            sl_price = entry - risk if s == 1 else entry + risk
            tp_price = entry + rr * risk if s == 1 else entry - rr * risk
            in_pos = True
            direction = s
            entry_i = i
            entry_time = df.index[i]
            continue
        else:
            hit_sl = (lo[i] <= sl_price) if direction == 1 else (hi[i] >= sl_price)
            hit_tp = (hi[i] >= tp_price) if direction == 1 else (lo[i] <= tp_price)
            exitp = None
            if hit_sl:
                exitp = sl_price
            elif hit_tp:
                exitp = tp_price
            elif i - entry_i >= max_hold:
                exitp = cl[i]
            if exitp is not None:
                pnl = (exitp - entry) if direction == 1 else (entry - exitp)
                R = pnl / (sl_mult * atrv[entry_i - 1])
                trades.append(dict(
                    entry_time=entry_time, exit_time=df.index[i], dir=direction,
                    entry=entry, sl=sl_price, tp=tp_price, exit=exitp, R=R,
                ))
                in_pos = False
    return pd.DataFrame(trades)


def apply_quality_filter(trades_df, meta_by_entry_time):
    trades_df = trades_df.copy()
    trades_df['sweep_ratio'] = trades_df['entry_time'].map(
        lambda x: meta_by_entry_time.get(x, {}).get('sweep_ratio', np.nan))
    trades_df['n_opp'] = trades_df['entry_time'].map(
        lambda x: meta_by_entry_time.get(x, {}).get('n_opp', np.nan))
    sr_thresh = trades_df['sweep_ratio'].quantile(0.5)
    nopp_q = trades_df['n_opp'].quantile([0.33, 0.66]).values
    return trades_df[
        (trades_df['sweep_ratio'] >= sr_thresh) &
        (trades_df['n_opp'] >= nopp_q[0]) &
        (trades_df['n_opp'] <= nopp_q[1])
    ].reset_index(drop=True)
