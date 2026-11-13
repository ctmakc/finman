#!/usr/bin/env python3
"""Submits the iOS App Store version for review; retries while screenshots are still processing."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from asc import get, post, patch
APP = os.environ["ASC_APP"]; SID = sys.argv[1]
ver = get(f"/v1/apps/{APP}/appStoreVersions?filter[platform]=IOS")["data"][0]["id"]
for attempt in range(30):
    it = post("/v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": SID}}, "appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver}}}}})
    errs = json.dumps(it.get("errors") or [], ensure_ascii=False)
    if it.get("errors") and "ASSET_IN_POST_PROCESSING" in errs:
        time.sleep(40); continue
    if it.get("errors") and "already" not in errs.lower():
        print("ERR", errs[:1500]); sys.exit(1)
    r = patch(f"/v1/reviewSubmissions/{SID}", {"data": {"type": "reviewSubmissions", "id": SID, "attributes": {"submitted": True}}})
    print("SUBMITTED", r.get("errors") and [e["detail"][:300] for e in r["errors"]] or r["data"]["attributes"].get("state")); sys.exit(0)
print("TIMEOUT"); sys.exit(2)
