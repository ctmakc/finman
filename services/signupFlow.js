// services/signupFlow.js — one place for "a new account exists":
// store where it came from (tracker.recordAcquisition), mirror to the
// self-hosted analytics, then send the operator email with the source.
// Fire-and-forget: nothing here may block or fail the sign-up response.
'use strict';

const tracker = require('./tracker');
const { notifySignup } = require('./signupNotify');
const logger = require('../lib/logger');

// Awaited by the caller: the acquisition insert is a quick local write, and
// the operator email must already be on its way when the response goes out.
// The email itself and the OpenPanel calls are not awaited (signupNotify.flush
// and tracker.flush wait for them).
async function handleSignup(user, method, rawAttribution, req, extra = {}) {
  let acq = null;
  try {
    acq = await tracker.recordAcquisition(user, method, rawAttribution, req, extra);
  } catch (e) {
    logger.warn({ err: e.message }, '[signup] acquisition failed');
  }
  try {
    await require('./referral').attach(user, acq);
  } catch (e) {
    logger.warn({ err: e.message }, '[signup] referral failed');
  }
  try {
    notifySignup(user, method, { acquisition: acq });
  } catch (e) {
    logger.error({ err: e.message }, '[signup] notify failed');
  }
  return acq;
}

function flush() {
  return Promise.all([require('./signupNotify').flush(), tracker.flush()]);
}

module.exports = { handleSignup, flush };
