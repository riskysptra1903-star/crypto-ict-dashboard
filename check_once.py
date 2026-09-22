"""
Dipanggil oleh GitHub Actions tiap ~10-15 menit (bukan loop terus-terusan).
Satu kali: cek sinyal baru di 28 coin, update trade_log.csv/state.json,
kirim Telegram kalau ada sinyal/TP/SL baru, lalu tulis ulang docs/signals.json
dan docs/status.json supaya dashboard statis (GitHub Pages) selalu dapat data terbaru.
"""
import json
import os

import bot_worker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOCS_DIR = os.path.join(BASE_DIR, "docs")


def write_static_json():
    trades = bot_worker.load_log()
    state = bot_worker.load_state()

    if len(trades) == 0:
        signals_out = {"total": 0, "wins": 0, "losses": 0, "open": 0,
                        "win_rate": None, "profit_factor": None, "recent": []}
    else:
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
        signals_out = {
            "total": n_total, "wins": n_wins, "losses": n_losses, "open": n_open,
            "win_rate": win_rate, "profit_factor": pf,
            "recent": recent.fillna("").to_dict(orient="records"),
        }

    status_out = {
        "coins_monitored": len(bot_worker.SYMBOLS),
        "coins": bot_worker.SYMBOLS,
        "n_open": signals_out.get("open", 0),
        "start_date": state.get("_start_date"),
        "heartbeat_date": state.get("_heartbeat_date"),
        "last_check_utc": __import__("datetime").datetime.utcnow().isoformat(),
    }

    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(os.path.join(DOCS_DIR, "signals.json"), "w") as f:
        json.dump(signals_out, f, default=str, indent=2)
    with open(os.path.join(DOCS_DIR, "status.json"), "w") as f:
        json.dump(status_out, f, default=str, indent=2)


if __name__ == "__main__":
    state = bot_worker.load_state()
    state = bot_worker.main_once(state, verbose=True)
    bot_worker.maybe_heartbeat(state)
    write_static_json()
    print("Selesai 1x cek + docs/signals.json & docs/status.json ditulis ulang.")
