#!/usr/bin/env python3
"""Fills the App Store record of Finman through the ASC API: categories, app-info localization (name, subtitle,
privacy URL), version localization (description, keywords, promo, what's new, URLs), copyright, age rating,
price (free), review details with the demo account. Idempotent: re-run safely.

usage: ASC_APP=<apple id> python3 asc_setup.py
Texts: /data/projects/finman-store-assets/listing.json (key apple.*).
Demo account: ~/.config/finman-app/review-demo.env (DEMO_EMAIL, DEMO_PASSWORD); never stored in the repo.
Review notes: mobile/store/review-notes.txt (DEMO_EMAIL is substituted, the password is not written there)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from asc import get, post, patch

APP = os.environ["ASC_APP"]
HERE = os.path.dirname(os.path.abspath(__file__))
L = json.load(open(os.environ.get("FM_LISTING", "/data/projects/finman-store-assets/listing.json")))
AP, U = L["apple"], L["urls"]
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/.config/finman-app/review-demo.env")) if "=" in l)
LOC = "en-US"


def ok(r, what):
    if r.get("errors") or r.get("_httperror"):
        print("ERR", what, json.dumps(r.get("errors") or r)[:800])
    else:
        print("ok ", what)
    return r


info = next(i for i in get(f"/v1/apps/{APP}/appInfos")["data"] if i["attributes"].get("appStoreState") != "READY_FOR_SALE")["id"]
ok(patch(f"/v1/appInfos/{info}", {"data": {"type": "appInfos", "id": info, "relationships": {
    "primaryCategory": {"data": {"type": "appCategories", "id": "FINANCE"}},
    "secondaryCategory": {"data": {"type": "appCategories", "id": "PRODUCTIVITY"}}}}}), "categories")

have = {x["attributes"]["locale"]: x["id"] for x in get(f"/v1/appInfos/{info}/appInfoLocalizations?limit=50")["data"]}
attrs = {"name": AP["name"], "subtitle": AP["subtitle"], "privacyPolicyUrl": U["privacy"]}
if LOC in have:
    ok(patch(f"/v1/appInfoLocalizations/{have[LOC]}", {"data": {"type": "appInfoLocalizations", "id": have[LOC], "attributes": attrs}}), "appInfo en-US")
else:
    ok(post("/v1/appInfoLocalizations", {"data": {"type": "appInfoLocalizations", "attributes": {"locale": LOC, **attrs},
        "relationships": {"appInfo": {"data": {"type": "appInfos", "id": info}}}}}), "appInfo+ en-US")

ver = get(f"/v1/apps/{APP}/appStoreVersions?filter[platform]=IOS")["data"][0]["id"]
ok(patch(f"/v1/appStoreVersions/{ver}", {"data": {"type": "appStoreVersions", "id": ver, "attributes": {
    "copyright": AP["copyright"], "versionString": "1.0.0", "releaseType": "AFTER_APPROVAL"}}}), "version")
vh = {x["attributes"]["locale"]: x["id"] for x in get(f"/v1/appStoreVersions/{ver}/appStoreVersionLocalizations?limit=50")["data"]}
attrs = {"description": AP["description"], "keywords": AP["keywords"], "promotionalText": AP["promotional_text"],
         "supportUrl": U["support"], "marketingUrl": U["marketing"]}
# whatsNew is rejected on the first version of an app; it is set only for updates.
if LOC in vh:
    ok(patch(f"/v1/appStoreVersionLocalizations/{vh[LOC]}", {"data": {"type": "appStoreVersionLocalizations", "id": vh[LOC], "attributes": attrs}}), "version en-US")
else:
    ok(post("/v1/appStoreVersionLocalizations", {"data": {"type": "appStoreVersionLocalizations", "attributes": {"locale": LOC, **attrs},
        "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver}}}}}), "version+ en-US")

# Age rating: personal finance tool, nothing objectionable, no UGC, no chat between people (listing.json apple.age_rating).
ar = get(f"/v1/appInfos/{info}/ageRatingDeclaration")
if ar.get("data"):
    aid = ar["data"]["id"]
    a = {k: "NONE" for k in ["alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "horrorOrFearThemes",
         "matureOrSuggestiveThemes", "medicalOrTreatmentInformation", "profanityOrCrudeHumor", "sexualContentGraphicAndNudity",
         "sexualContentOrNudity", "violenceCartoonOrFantasy", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic",
         "gunsOrOtherWeapons"]}
    a.update({"gambling": False, "lootBox": False, "unrestrictedWebAccess": False, "messagingAndChat": False,
              "userGeneratedContent": False, "advertising": False, "ageAssurance": False, "socialMedia": False,
              "healthOrWellnessTopics": False, "parentalControls": False})
    for _ in range(4):
        r = patch(f"/v1/ageRatingDeclarations/{aid}", {"data": {"type": "ageRatingDeclarations", "id": aid, "attributes": a}})
        if not r.get("errors"):
            break
        bad = {e.get("source", {}).get("pointer", "").split("/")[-1] for e in r["errors"]}
        if not bad - {""}:
            break
        a = {k: v for k, v in a.items() if k not in bad}
    ok(r, "age rating")

# Price: free in every territory.
pts = get(f"/v1/apps/{APP}/appPricePoints?filter[territory]=USA&limit=1")
if pts.get("data"):
    free = pts["data"][0]["id"]
    ok(post("/v1/appPriceSchedules", {"data": {"type": "appPriceSchedules", "relationships": {
        "app": {"data": {"type": "apps", "id": APP}},
        "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
        "manualPrices": {"data": [{"type": "appPrices", "id": "${p0}"}]}}},
        "included": [{"type": "appPrices", "id": "${p0}", "attributes": {"startDate": None},
                      "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free}}}}]}), "price free")

notes = open(os.path.join(HERE, "..", "review-notes.txt")).read().replace("DEMO_EMAIL", env["DEMO_EMAIL"]).strip()
rv = get(f"/v1/appStoreVersions/{ver}/appStoreReviewDetail")
attrs = {"contactFirstName": os.environ.get("ASC_CONTACT_FIRST", "Maksym"), "contactLastName": os.environ.get("ASC_CONTACT_LAST", "Stepanenko"),
         "contactPhone": os.environ.get("ASC_CONTACT_PHONE", "+16138677767"), "contactEmail": "info@finman.money",
         "demoAccountName": env["DEMO_EMAIL"], "demoAccountPassword": env["DEMO_PASSWORD"], "demoAccountRequired": True, "notes": notes}
if rv.get("data"):
    ok(patch(f"/v1/appStoreReviewDetails/{rv['data']['id']}", {"data": {"type": "appStoreReviewDetails", "id": rv["data"]["id"], "attributes": attrs}}), "review detail")
else:
    ok(post("/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": attrs,
        "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver}}}}}), "review detail+")
print("version", ver, "appInfo", info)
