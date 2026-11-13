#!/usr/bin/env bash
# Finman iOS: everything after the App Store Connect record exists.
#   Before: the owner logs in to appstoreconnect.apple.com (2FA); an agent creates the record
#   (Apps -> + -> New App: iOS, name "Finman: AI CFO & Budget", English (U.S.), bundle money.finman.app,
#   SKU finman-ios, full access) and fills App Privacy from
#   /data/projects/finman-store-assets/docs/PRIVACY-ANSWERS.md (section "Apple: App Privacy") -> Publish.
#   Then: bash ios_morning.sh            (finds the app id by bundle id)
#   Steps: cloud build + TestFlight upload, listing texts/age rating/price/review info,
#   screenshots 6.7" + 6.5", build attach, submit for review.  Stops on the first error.
set -euo pipefail
cd "$(dirname "$0")"
REPO=ctmakc/finman
SHOTS=/data/projects/finman-store-assets/store/screenshots
export ASC_APP=$(python3 -c "from asc import get;print(get('/v1/apps?filter[bundleId]=money.finman.app')['data'][0]['id'])")
echo "ASC app $ASC_APP"

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  gh workflow run "iOS TestFlight" -R "$REPO" --ref main -f upload=true
  sleep 15
  RUN=$(gh run list -R "$REPO" --workflow "iOS TestFlight" --limit 1 --json databaseId -q '.[0].databaseId')
  echo "workflow run $RUN"; gh run watch "$RUN" -R "$REPO" --exit-status --interval 60 >/dev/null
fi

python3 asc_setup.py
ASC_DISPLAY=APP_IPHONE_67 python3 asc_shots.py "$SHOTS/apple-6.7" en-US
ASC_DISPLAY=APP_IPHONE_65 python3 asc_shots.py "$SHOTS/apple-6.5" en-US
python3 asc_build.py --wait-min 90

SID=$(python3 - <<'PY'
import os
from asc import get, post
app=os.environ["ASC_APP"]
open_=[s for s in get(f"/v1/reviewSubmissions?filter[app]={app}&filter[platform]=IOS")["data"] if s["attributes"]["state"]=="READY_FOR_REVIEW"]
r=open_[0] if open_ else post("/v1/reviewSubmissions",{"data":{"type":"reviewSubmissions","attributes":{"platform":"IOS"},"relationships":{"app":{"data":{"type":"apps","id":app}}}}})["data"]
print(r["id"])
PY
)
python3 asc_submit.py "$SID"
python3 -c "
from asc import get;import os
v=get(f'/v1/apps/{os.environ[\"ASC_APP\"]}/appStoreVersions?filter[platform]=IOS')['data'][0]['attributes']
print('version', v['versionString'], v.get('appVersionState') or v.get('appStoreState'))"
echo "https://appstoreconnect.apple.com/apps/$ASC_APP/distribution/ios/version/inflight"
