// services/geo.js — IP -> country (and city when the city database is present).
//
// Databases: DB-IP Lite (free, CC BY 4.0, https://db-ip.com), MaxMind format.
// GEO_DB_DIR (default <data>/geo) holds dbip-country-lite.mmdb and optionally
// dbip-city-lite.mmdb; scripts/geo-update.sh refreshes them monthly.
// No database -> lookup() returns {} and nothing breaks.
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

let readers = null; // { city, country } once loaded

function geoDir() {
  if (process.env.GEO_DB_DIR) return process.env.GEO_DB_DIR;
  const dbPath = process.env.DATABASE_PATH || './data/finance.db';
  return path.join(path.dirname(path.resolve(dbPath)), 'geo');
}

function openReader(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const { Reader } = require('maxmind');
    return new Reader(fs.readFileSync(file));
  } catch (e) {
    logger.warn({ err: e.message, file }, 'geo: cannot open database');
    return null;
  }
}

function load() {
  if (readers) return readers;
  const dir = geoDir();
  readers = {
    city: openReader(path.join(dir, 'dbip-city-lite.mmdb')),
    country: openReader(path.join(dir, 'dbip-country-lite.mmdb')),
  };
  return readers;
}

function reset() { readers = null; }

function cleanIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

function isPrivate(ip) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
}

// -> { country: 'CA', countryName: 'Canada', city: 'Ottawa', region: 'Ontario' } (fields optional)
function lookup(rawIp) {
  const ip = cleanIp(rawIp);
  if (!ip || isPrivate(ip)) return {};
  const r = load();
  const reader = r.city || r.country;
  if (!reader) return {};
  try {
    const rec = reader.get(ip);
    if (!rec) return {};
    const out = {};
    if (rec.country) {
      out.country = rec.country.iso_code;
      out.countryName = rec.country.names && rec.country.names.en;
    }
    if (rec.city && rec.city.names) out.city = rec.city.names.en;
    if (rec.subdivisions && rec.subdivisions[0] && rec.subdivisions[0].names) {
      out.region = rec.subdivisions[0].names.en;
    }
    return out;
  } catch (e) {
    return {};
  }
}

module.exports = { lookup, reset, cleanIp, geoDir };
