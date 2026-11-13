import json, time, os, sys, urllib.request, urllib.error
import jwt

KEY = "/data/projects/foundwall/.asc-key.p8"
KID = "KZFRJ6J6LY"
ISS = "f49d2a8a-3431-467e-8c11-418cfde78b89"
BASE = "https://api.appstoreconnect.apple.com"

_tok = {"t": None, "exp": 0}

def token():
    now = int(time.time())
    if _tok["t"] and _tok["exp"] - now > 60:
        return _tok["t"]
    with open(KEY) as f:
        pk = f.read()
    payload = {"iss": ISS, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}
    t = jwt.encode(payload, pk, algorithm="ES256", headers={"kid": KID, "typ": "JWT"})
    _tok["t"] = t
    _tok["exp"] = now + 900
    return t

def req(method, path, body=None, raw=None, headers=None, expect_json=True, auth=True):
    url = path if path.startswith("http") else BASE + path
    data = None
    h = {"Authorization": "Bearer " + token()} if auth else {}
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            b = resp.read()
            if not b:
                return {"_status": resp.status}
            try:
                return json.loads(b)
            except Exception:
                return {"_status": resp.status, "_raw": b[:500].decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        b = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(b)
        except Exception:
            j = {"_raw": b[:2000]}
        j["_httperror"] = e.code
        return j

def get(p, **kw):
    return req("GET", p, **kw)

def post(p, body):
    return req("POST", p, body=body)

def patch(p, body):
    return req("PATCH", p, body=body)

def pp(x):
    print(json.dumps(x, ensure_ascii=False, indent=2))
