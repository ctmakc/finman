// engine/shims/express.js — the slice of Express the Finman routers use, without Node http.
// Router with get/post/put/patch/delete/all/use, route params (:id, :id(\\d+), :id?, *),
// nested routers, middleware chains with next(err) / next('route') / next('router'),
// error middleware (4 args). Request / response objects are built by engine/src/app.js.
'use strict';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function escapeRe(s) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }

// '/:id(\\d+)/members/:userId?' -> { re, keys }. end=false: prefix match (use()).
function compile(path, end) {
  if (path instanceof RegExp) return { re: path, keys: [], regex: true };
  const keys = [];
  let src = '';
  const p = String(path || '/');
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === ':') {
      let j = i + 1;
      while (j < p.length && /[A-Za-z0-9_$]/.test(p[j])) j += 1;
      const name = p.slice(i + 1, j);
      let pattern = '[^/]+?';
      if (p[j] === '(') {
        let depth = 1; let k = j + 1;
        while (k < p.length && depth) { if (p[k] === '\\') k += 1; else if (p[k] === '(') depth += 1; else if (p[k] === ')') depth -= 1; k += 1; }
        pattern = p.slice(j + 1, k - 1);
        j = k;
      }
      let optional = false;
      if (p[j] === '?') { optional = true; j += 1; }
      keys.push(name);
      if (optional && src.endsWith('/')) src = src.slice(0, -1) + `(?:/(${pattern}))?`;
      else src += optional ? `(${pattern})?` : `(${pattern})`;
      i = j;
    } else if (c === '*') {
      keys.push(String(keys.length));
      src += '(.*)';
      i += 1;
    } else {
      src += escapeRe(c);
      i += 1;
    }
  }
  if (src.length > 1 && src.endsWith('/')) src = src.slice(0, -1);
  const tail = end ? '/?$' : (src === '/' || src === '' ? '' : '(?=/|$)');
  if (src === '/' && !end) src = '';
  return { re: new RegExp(`^${src}${tail}`, 'i'), keys };
}

function decode(v) {
  if (v === undefined) return undefined;
  try { return decodeURIComponent(v); } catch (_) { return v; }
}

function flatten(args) {
  const out = [];
  for (const a of args) { if (Array.isArray(a)) out.push(...flatten(a)); else out.push(a); }
  return out;
}

function createRouter(options = {}) {
  const stack = [];

  function router(req, res, out) { return router.handle(req, res, out); }
  router.stack = stack;
  router.mergeParams = !!options.mergeParams;

  router.use = function use(...args) {
    let path = '/';
    if (typeof args[0] === 'string' || args[0] instanceof RegExp || (Array.isArray(args[0]) && typeof args[0][0] === 'string')) path = args.shift();
    const paths = Array.isArray(path) ? path : [path];
    for (const fn of flatten(args)) {
      if (typeof fn !== 'function') throw new TypeError('Router.use() requires a middleware function');
      for (const p of paths) stack.push({ kind: 'use', ...compile(p, false), handle: fn });
    }
    return router;
  };

  function addRoute(method, path, handlers) {
    const fns = flatten(handlers);
    const paths = Array.isArray(path) ? path : [path];
    for (const p of paths) stack.push({ kind: 'route', method, ...compile(p, true), handlers: fns });
    return router;
  }
  for (const m of METHODS) router[m] = (path, ...h) => addRoute(m.toUpperCase(), path, h);
  router.del = router.delete;
  router.all = (path, ...h) => addRoute('*', path, h);
  router.route = (path) => {
    const api = {};
    for (const m of METHODS) api[m] = (...h) => { addRoute(m.toUpperCase(), path, h); return api; };
    api.all = (...h) => { addRoute('*', path, h); return api; };
    return api;
  };
  router.param = () => router; // unused by Finman routers

  router.handle = function handle(req, res, done) {
    let idx = 0;
    const parentUrl = req.url;
    const parentBase = req.baseUrl || '';
    const parentParams = req.params || {};
    const pathOnly = () => (req.url.split('?')[0] || '/');

    const restore = () => { req.url = parentUrl; req.baseUrl = parentBase; req.params = parentParams; };

    function next(err) {
      if (err === 'router') { restore(); return done(); }
      if (err === 'route') err = undefined;
      restore();
      if (res.writableEnded && !err) return undefined;
      while (idx < stack.length) {
        const layer = stack[idx++];
        const path = pathOnly();
        const m = layer.re.exec(path);
        if (!m) continue;
        if (layer.kind === 'route') {
          const method = req.method === 'HEAD' && layer.method === 'GET' ? 'GET' : req.method;
          if (layer.method !== '*' && layer.method !== method) continue;
        }
        const params = router.mergeParams ? { ...parentParams } : {};
        layer.keys.forEach((k, i) => { if (m[i + 1] !== undefined) params[k] = decode(m[i + 1]); });
        req.params = layer.kind === 'use' && !router.mergeParams && !layer.keys.length ? { ...parentParams } : params;

        if (layer.kind === 'use') {
          const matched = m[0];
          if (matched) {
            req.baseUrl = parentBase + matched;
            const rest = req.url.slice(matched.length);
            req.url = rest.startsWith('/') ? rest : '/' + rest;
          }
          return call(layer.handle, err, next);
        }
        return runRoute(layer.handlers, err, next);
      }
      return done(err);
    }

    function runRoute(handlers, err, outerNext) {
      let i = 0;
      function step(e) {
        if (e === 'route') return outerNext();
        if (e === 'router') return outerNext('router');
        if (i >= handlers.length) return outerNext(e);
        return call(handlers[i++], e, step);
      }
      return step(err);
    }

    function call(fn, err, nxt) {
      const isErrorHandler = fn.length === 4;
      if (err && !isErrorHandler) return nxt(err);
      if (!err && isErrorHandler) return nxt();
      let called = false;
      const once = (e) => { if (called) return undefined; called = true; return nxt(e); };
      try {
        const r = isErrorHandler ? fn(err, req, res, once) : fn(req, res, once);
        if (r && typeof r.then === 'function') {
          res._track(r.then(undefined, (e) => once(e || new Error('Rejected'))));
        }
      } catch (e) {
        return once(e);
      }
      return undefined;
    }

    return next();
  };

  return router;
}

const passthrough = () => (req, res, next) => next();

function express() { return createRouter(); }
express.Router = createRouter;
express.json = passthrough;
express.text = passthrough;
express.raw = passthrough;
express.urlencoded = passthrough;
express.static = passthrough;
express._compile = compile;

module.exports = express;
module.exports.Router = createRouter;
