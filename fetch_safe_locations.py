"""
Fetch candidate safe/evacuation locations for Badulla District from OpenStreetMap.

Queries one category at a time with retries across several Overpass mirrors, so a
single busy server does not fail the whole run. Assigns each location to its
nearest DS division centroid and writes safe_locations.json.

IMPORTANT: these are CANDIDATE locations derived from open map data. Verify against
the Disaster Management Centre's designated safe-location register before any
operational use. The 'verified' flag records that status.

Usage:
    python fetch_safe_locations.py
"""
import json
import math
import time
import urllib.request
import urllib.parse
import urllib.error

# Several mirrors — if one is busy the next is tried
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Badulla District bounding box (south, west, north, east)
BBOX = (6.54, 80.77, 7.63, 81.28)

CENTROIDS = {
    "Badulla": (6.989, 81.055), "Bandarawela": (6.833, 80.987), "Ella": (6.872, 81.046),
    "Haldummulla": (6.762, 80.888), "Hali-Ela": (6.962, 81.036), "Haputale": (6.768, 80.951),
    "Kandaketiya": (7.108, 80.995), "Lunugala": (7.033, 81.200), "Mahiyanganaya": (7.331, 81.010),
    "Meegahakivula": (7.150, 81.070), "Passara": (6.933, 81.153), "Rideemaliyadda": (7.243, 81.100),
    "Soranathota": (7.033, 81.010), "Uva Paranagama": (6.933, 80.900), "Welimada": (6.905, 80.913),
}

# (osm key, osm value, label shown to users)
CATEGORIES = [
    ("amenity", "school",          "School"),
    ("amenity", "place_of_worship","Place of worship"),
    ("amenity", "community_centre","Community hall"),
    ("amenity", "hospital",        "Hospital"),
    ("amenity", "college",         "College"),
    ("amenity", "townhall",        "Government office"),
]


def query_for(key, val):
    s, w, n, e = BBOX
    return (
        f'[out:json][timeout:90];\n'
        f'(\n'
        f'  node["{key}"="{val}"]({s},{w},{n},{e});\n'
        f'  way["{key}"="{val}"]({s},{w},{n},{e});\n'
        f');\n'
        f'out center tags;'
    )


def run_query(q, attempts=3):
    """Try each mirror, with a short wait between attempts."""
    last = None
    for attempt in range(attempts):
        for url in ENDPOINTS:
            try:
                data = urllib.parse.urlencode({"data": q}).encode()
                req = urllib.request.Request(
                    url, data=data,
                    headers={"User-Agent": "badulla-ews-research/1.0 (academic project)"}
                )
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as ex:
                last = f"{url.split('/')[2]}: {ex}"
                continue
        wait = 8 * (attempt + 1)
        print(f"      all mirrors busy ({last}) — waiting {wait}s")
        time.sleep(wait)
    return None


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def nearest_division(lat, lon):
    best, best_d = None, 1e9
    for name, (dlat, dlon) in CENTROIDS.items():
        d = haversine_km(lat, lon, dlat, dlon)
        if d < best_d:
            best, best_d = name, d
    return best, round(best_d, 2)


def main():
    print("Fetching candidate safe locations for Badulla District from OpenStreetMap\n")
    seen, out = set(), []

    for key, val, label in CATEGORIES:
        print(f"   {label:20} ...", end=" ", flush=True)
        payload = run_query(query_for(key, val))
        if payload is None:
            print("FAILED (skipped)")
            continue

        added = 0
        for el in payload.get("elements", []):
            tags = el.get("tags", {})
            name = tags.get("name") or tags.get("name:en")
            if not name:
                continue
            lat = el.get("lat") or el.get("center", {}).get("lat")
            lon = el.get("lon") or el.get("center", {}).get("lon")
            if lat is None or lon is None:
                continue
            k = (name.strip().lower(), round(lat, 4), round(lon, 4))
            if k in seen:
                continue
            seen.add(k)

            division, dist = nearest_division(lat, lon)
            out.append({
                "id": f"{el['type']}/{el['id']}",
                "name": name.strip(),
                "kind": label,
                "latitude": round(lat, 6),
                "longitude": round(lon, 6),
                "division": division,
                "kmFromDivisionCentre": dist,
                "capacity": None,
                "verified": False,
                "source": "OpenStreetMap",
            })
            added += 1
        print(f"{added} found")
        time.sleep(3)          # be polite to the public API

    if not out:
        print("\nNo locations retrieved. Check your internet connection and try again later.")
        return

    out.sort(key=lambda x: (x["division"], x["name"]))
    with open("safe_locations.json", "w", encoding="utf-8") as f:
        json.dump({
            "generated": time.strftime("%Y-%m-%d"),
            "source": "OpenStreetMap contributors, ODbL",
            "note": "Candidate evacuation points. Verify against the DMC designated safe-location register before operational use.",
            "count": len(out),
            "locations": out,
        }, f, indent=2, ensure_ascii=False)

    print(f"\nWrote safe_locations.json with {len(out)} candidate locations\n")
    per_div = {}
    for loc in out:
        per_div[loc["division"]] = per_div.get(loc["division"], 0) + 1
    for d in sorted(CENTROIDS):
        n = per_div.get(d, 0)
        print(f"   {d:18} {n:3}{'   <-- none found' if n == 0 else ''}")


if __name__ == "__main__":
    main()