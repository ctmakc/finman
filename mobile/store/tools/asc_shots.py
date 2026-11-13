#!/usr/bin/env python3
"""Uploads 6.7-inch iPhone screenshots to the App Store version localizations (ASC API asset upload).
usage: asc_shots.py <dir-with-pngs> <locale> [<locale> ...]   (PNG 1290x2796, sorted by name)"""
import hashlib, json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from asc import get, post, patch, req

APP = os.environ["ASC_APP"]
DISPLAY = os.environ.get("ASC_DISPLAY", "APP_IPHONE_67")  # APP_IPHONE_65 for 1284x2778
src, locales = sys.argv[1], sys.argv[2:]
files = sorted(f for f in os.listdir(src) if f.endswith(".png"))[:10]
ver = get(f"/v1/apps/{APP}/appStoreVersions?filter[platform]=IOS")["data"][0]["id"]
locs = {x["attributes"]["locale"]: x["id"] for x in get(f"/v1/appStoreVersions/{ver}/appStoreVersionLocalizations?limit=50")["data"]}
for loc in locales:
    lid = locs[loc]
    sets = get(f"/v1/appStoreVersionLocalizations/{lid}/appScreenshotSets")["data"]
    sset = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == DISPLAY), None)
    if sset:  # replace: delete old screenshots of this set
        for sh in get(f"/v1/appScreenshotSets/{sset['id']}/appScreenshots")["data"]:
            req("DELETE", f"/v1/appScreenshots/{sh['id']}")
    else:
        sset = post("/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": DISPLAY},
                    "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": lid}}}}})["data"]
    for f in files:
        path = os.path.join(src, f)
        data = open(path, "rb").read()
        r = post("/v1/appScreenshots", {"data": {"type": "appScreenshots", "attributes": {"fileName": f, "fileSize": len(data)},
                 "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": sset["id"]}}}}})
        if r.get("errors"):
            print("ERR", loc, f, r["errors"][0].get("detail")); continue
        sid = r["data"]["id"]
        for op in r["data"]["attributes"]["uploadOperations"]:
            chunk = data[op["offset"]: op["offset"] + op["length"]]
            h = {x["name"]: x["value"] for x in op["requestHeaders"]}
            rq = urllib.request.Request(op["url"], data=chunk, method=op["method"], headers=h)
            urllib.request.urlopen(rq).read()
        c = patch(f"/v1/appScreenshots/{sid}", {"data": {"type": "appScreenshots", "id": sid, "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
        print(loc, f, "ok" if not c.get("errors") else c["errors"][0].get("detail"))
