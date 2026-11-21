// engine/shims/multer.js — the engine hands uploaded files over already parsed
// (req._engineFiles: [{ fieldname, originalname, mimetype, buffer }]); this maps them onto
// req.file / req.files exactly as multer would, honouring fileFilter and limits.
// diskStorage "writes" into the in-memory fs shim so code that reads req.file.path works.
'use strict';

const fs = require('fs');
const path = require('path');

let seq = 0;

class MulterError extends Error {
  constructor(code, field) {
    super({ LIMIT_FILE_SIZE: 'File too large', LIMIT_FILE_COUNT: 'Too many files', LIMIT_UNEXPECTED_FILE: 'Unexpected field' }[code] || code);
    this.name = 'MulterError';
    this.code = code;
    this.field = field;
  }
}

function memoryStorage() { return { kind: 'memory' }; }
function diskStorage(opts = {}) { return { kind: 'disk', opts }; }

function cbValue(fn, req, file, fallback) {
  return new Promise((resolve, reject) => {
    if (typeof fn === 'string') return resolve(fn);
    if (typeof fn !== 'function') return resolve(fallback);
    fn(req, file, (err, v) => (err ? reject(err) : resolve(v)));
  });
}

function multer(options = {}) {
  const storage = options.storage || (options.dest ? diskStorage({ destination: options.dest }) : memoryStorage());
  const limits = options.limits || {};

  async function accept(req, list) {
    const out = [];
    if (limits.files !== undefined && list.length > limits.files) throw new MulterError('LIMIT_FILE_COUNT');
    for (const f of list) {
      const file = {
        fieldname: f.fieldname,
        originalname: f.originalname,
        encoding: '7bit',
        mimetype: f.mimetype || 'application/octet-stream',
        size: f.buffer.length,
      };
      if (limits.fileSize !== undefined && file.size > limits.fileSize) throw new MulterError('LIMIT_FILE_SIZE', f.fieldname);
      if (typeof options.fileFilter === 'function') {
        const ok = await new Promise((resolve, reject) => options.fileFilter(req, file, (err, yes) => (err ? reject(err) : resolve(yes))));
        if (!ok) continue;
      }
      if (storage.kind === 'disk') {
        const dir = await cbValue(storage.opts.destination, req, file, '/tmp');
        const name = await cbValue(storage.opts.filename, req, file, `upload-${Date.now()}-${++seq}`);
        file.destination = dir;
        file.filename = name;
        file.path = path.join(dir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file.path, f.buffer);
      } else {
        file.buffer = f.buffer;
      }
      out.push(file);
    }
    return out;
  }

  const files = (req) => (Array.isArray(req._engineFiles) ? req._engineFiles : []);
  const mw = (pick) => (req, res, next) => {
    Promise.resolve()
      .then(() => pick(req))
      .then(() => next(), (e) => next(e));
  };

  return {
    single: (field) => mw(async (req) => {
      const list = files(req).filter((f) => f.fieldname === field);
      const extra = files(req).find((f) => f.fieldname !== field);
      if (extra) throw new MulterError('LIMIT_UNEXPECTED_FILE', extra.fieldname);
      const got = await accept(req, list.slice(0, 1));
      req.file = got[0];
    }),
    array: (field, max) => mw(async (req) => {
      const list = files(req).filter((f) => f.fieldname === field);
      if (max !== undefined && list.length > max) throw new MulterError('LIMIT_UNEXPECTED_FILE', field);
      req.files = await accept(req, list);
    }),
    fields: (spec) => mw(async (req) => {
      req.files = {};
      for (const { name, maxCount } of spec) {
        const list = files(req).filter((f) => f.fieldname === name);
        if (maxCount !== undefined && list.length > maxCount) throw new MulterError('LIMIT_UNEXPECTED_FILE', name);
        const got = await accept(req, list);
        if (got.length) req.files[name] = got;
      }
    }),
    any: () => mw(async (req) => { req.files = await accept(req, files(req)); }),
    none: () => mw(async (req) => { if (files(req).length) throw new MulterError('LIMIT_UNEXPECTED_FILE', files(req)[0].fieldname); }),
  };
}

multer.memoryStorage = memoryStorage;
multer.diskStorage = diskStorage;
multer.MulterError = MulterError;

module.exports = multer;
