# Helpers for Play Console forms in a background tab of the owner's Chrome (exec'd inside browser-harness).
import time
import os
A = "https://play.google.com/console/u/0/developers/5658655088701382437/app/" + os.environ.get("FM_PLAY_APP","") + "/"
def labels():
    return js("""[...document.querySelectorAll('material-radio,material-checkbox,[role=radio],[role=checkbox],mat-radio-button,mat-checkbox,label')].filter(e=>e.offsetParent).map(e=>e.innerText.trim().replace(/\\s+/g,' ').slice(0,90)).filter(Boolean)""")
def pick(text, exact=False):
    return js("""((t,ex)=>{const els=[...document.querySelectorAll('material-radio,material-checkbox,[role=radio],[role=checkbox],mat-radio-button,mat-checkbox,label')].filter(e=>e.offsetParent);
      const m=els.find(e=>{const s=e.innerText.trim().replace(/\\s+/g,' ');return ex? s===t : s.startsWith(t)});
      if(!m) return 'NOTFOUND '+t; const inp=m.querySelector('input')||m; inp.click(); return 'ok '+t})(%r,%s)""" % (text, 'true' if exact else 'false'))
def setval(label, value):
    return js("""((l,v)=>{const e=[...document.querySelectorAll('input,textarea')].find(e=>(e.getAttribute('aria-label')||'').startsWith(l));if(!e)return 'NOTFOUND '+l;e.focus();const P=e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(P.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();return 'ok '+l})(%r,%r)""" % (label, value))
def button(text):
    return js("""(t=>{const x=[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&b.innerText.trim().replace(/\\s+/g,' ')===t);if(!x.length)return 'NOTFOUND '+t;const b=x[x.length-1];if(b.disabled)return 'DISABLED '+t;b.click();return 'ok '+t})(%r)""" % text)
def body(n=1500):
    t = js("document.body.innerText"); i = t.find('sell'); return t[i+4:i+4+n] if i>0 else t[:n]
def go(path, wait=10):
    open_url(A + path); time.sleep(wait)
