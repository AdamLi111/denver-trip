#!/usr/bin/env python3
"""Read data/trip.json, fetch real road geometry for each driving leg from the
public OSRM server, and write data/bundle.js for the page to load.

Run again whenever trip.json changes:  python3 build.py
"""
import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
OSRM = "https://router.project-osrm.org/route/v1/driving/{a};{b}?overview=full&geometries=geojson"


def haversine_km(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def drive(a, b):
    url = OSRM.format(a=f"{a[1]},{a[0]}", b=f"{b[1]},{b[0]}")
    req = urllib.request.Request(url, headers={"User-Agent": "denver-trip-planner/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        route = json.load(r)["routes"][0]
    coords = [[round(lat, 5), round(lng, 5)] for lng, lat in route["geometry"]["coordinates"]]
    return coords, route["distance"] / 1000, route["duration"] / 60


def arc(a, b, n=64):
    # Quadratic bezier bowed to the north so the flight reads as a flight, not a road.
    mid = [(a[0] + b[0]) / 2 + abs(a[1] - b[1]) * 0.18, (a[1] + b[1]) / 2]
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append([
            round((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * mid[0] + t ** 2 * b[0], 5),
            round((1 - t) ** 2 * a[1] + 2 * (1 - t) * t * mid[1] + t ** 2 * b[1], 5),
        ])
    return pts


def main():
    trip = json.loads((ROOT / "data/trip.json").read_text())
    by_id = {e["id"]: e for e in trip["events"]}
    pt = lambda e: [e["lat"], e["lng"]]
    legs = []

    def add(day, frm, to, mode):
        a, b = pt(frm), pt(to)
        if mode == "drive":
            coords, km, mins = drive(a, b)
            time.sleep(0.4)
        elif mode == "walk":
            coords = [a, b]
            km = haversine_km(a, b) * 1.25
            mins = km / 2.5 * 60
        else:  # flight
            coords, km, mins = arc(a, b), haversine_km(a, b), 160
        legs.append({"day": day, "from": frm["id"], "to": to["id"], "mode": mode,
                     "km": round(km, 1), "min": round(mins), "coords": coords})
        print(f"D{day} {frm['id']:>12} -> {to['id']:<16} {mode:6} {km:6.1f} km {mins:5.0f} min")

    for day in trip["days"]:
        prev = by_id.get(day.get("startAt"))
        for e in (x for x in trip["events"] if x["day"] == day["id"]):
            frm = by_id[e["legFrom"]] if e.get("legFrom") else prev
            if frm and e["leg"] != "none":
                add(day["id"], frm, e, e["leg"])
            prev = e
        if day.get("returnTo"):
            add(day["id"], prev, by_id[day["returnTo"]], "drive")

    trip["legs"] = legs
    (ROOT / "data/bundle.js").write_text("window.TRIP = " + json.dumps(trip, ensure_ascii=False) + ";\n")
    print(f"wrote data/bundle.js ({len(legs)} legs)")


if __name__ == "__main__":
    main()
