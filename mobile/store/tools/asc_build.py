#!/usr/bin/env python3
"""Waits for the newest processed iOS build of the app, marks export compliance and attaches it to the
App Store version.  usage: ASC_APP=<id> python3 asc_build.py [--wait-min 60]"""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from asc import get, patch

APP = os.environ["ASC_APP"]
wait_min = int(sys.argv[sys.argv.index("--wait-min") + 1]) if "--wait-min" in sys.argv else 60
deadline = time.time() + wait_min * 60
while True:
    b = get(f"/v1/builds?filter[app]={APP}&sort=-uploadedDate&limit=1").get("data") or []
    st = b[0]["attributes"]["processingState"] if b else None
    print("build", b and b[0]["attributes"]["version"], st, flush=True)
    if st == "VALID":
        break
    if st in ("FAILED", "INVALID") or time.time() > deadline:
        sys.exit(f"no valid build ({st})")
    time.sleep(60)
bid = b[0]["id"]
if b[0]["attributes"].get("usesNonExemptEncryption") is None:  # Info.plist already says false; set it if Apple asks
    patch(f"/v1/builds/{bid}", {"data": {"type": "builds", "id": bid, "attributes": {"usesNonExemptEncryption": False}}})
ver = get(f"/v1/apps/{APP}/appStoreVersions?filter[platform]=IOS")["data"][0]["id"]
r = patch(f"/v1/appStoreVersions/{ver}/relationships/build", {"data": {"type": "builds", "id": bid}})
print("attached" if not r.get("errors") else r["errors"], "build", bid, "to version", ver)
