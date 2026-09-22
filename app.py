import json
import os
import threading

import pandas as pd
from flask import Flask, jsonify, render_template

import bot_worker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
LOG_FILE = os.path.join(BASE_DIR, "trade_log.csv")

COINS = bot_worker.SYMBOLS

app = Flask(__name__)

_worker_started = False


def start_worker_once():
    global _worker_started
    if not _worker_started:
        _worker_started = True
        t = threading.Thread(target=bot_worker.run_loop, daemon=True)
        t.start()


start_worker_once()


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def load_trades():
    if not os.path.exists(LOG_FILE):
        return pd.DataFrame()
    df = pd.read_csv(LOG_FILE)
    return df


@app.route("/")
def dashboard():
    return render_template("dashboard.html", coins=COINS)


@app.route("/api/status")
def api_status():
    state = load_state()
    trades = load_trades()
    n_open = int((trades["status"] == "OPEN").sum()) if len(trades) else 0
    return jsonify({
        "coins_monitored": len(COINS),
        "coins": COINS,
        "n_open": n_open,
        "start_date": state.get("_start_date"),
        "heartbeat_date": state.get("_heartbeat_date"),
    })


@app.route("/api/signals")
def api_signals():
    trades = load_trades()
    if len(trades) == 0:
        return jsonify({"total": 0, "wins": 0, "losses": 0, "open": 0, "win_rate": None,
                         "profit_factor": None, "recent": []})

    closed = trades[trades["status"].isin(["WIN", "LOSS"])].copy()
    n_total = len(closed)
    n_wins = int((closed["status"] == "WIN").sum())
    n_losses = int((closed["status"] == "LOSS").sum())
    n_open = int((trades["status"] == "OPEN").sum())
    win_rate = round(n_wins / n_total * 100, 1) if n_total > 0 else None

    gross_win = closed.loc[closed["R"] > 0, "R"].sum()
    gross_loss = -closed.loc[closed["R"] <= 0, "R"].sum()
    pf = round(gross_win / gross_loss, 2) if gross_loss > 0 else None

    recent = trades.sort_values("entry_time", ascending=False).head(20)
    recent_list = recent.fillna("").to_dict(orient="records")

    return jsonify({
        "total": n_total,
        "wins": n_wins,
        "losses": n_losses,
        "open": n_open,
        "win_rate": win_rate,
        "profit_factor": pf,
        "recent": recent_list,
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
