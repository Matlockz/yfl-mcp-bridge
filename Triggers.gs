/**
 * Triggers (idempotent) — 2025‑10‑20
 * Sets time‑based triggers for:
 *  - kickoffTranscriptsIndexV2 (daily)
 *  - inventoryWorker_          (daily, off-hours)
 *
 * Also includes: listTriggers(), clearTriggers(), showStatusNow()
 *
 * Notes:
 *  - Uses ScriptApp time-based triggers (ClockTriggerBuilder).
 *  - Safe to re-run; avoids duplicates by handler name.
 */

// ---------- Utilities ----------

/** Return an array of current triggers keyed by handler. */
function _getTriggersByHandler_() {
  const out = {};
  ScriptApp.getProjectTriggers().forEach(t => {
    const h = t.getHandlerFunction();
    (out[h] ||= []).push(t);
  });
  return out;
}

/** Create or replace a single time-based trigger for a handler. */
function _ensureDailyTrigger_(handler, hourUtc) {
  // Remove existing triggers for this handler
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  });
  // Create the new daily trigger at specified UTC hour
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hourUtc)              // UTC hour; script time zone applies internally
    .everyDays(1)
    .create();
}

/** Pretty JSON log helper. */
function _log_(obj) {
  Logger.log(JSON.stringify(obj, null, 2));
  return obj;
}

// ---------- Public: setup / list / clear ----------

/** Idempotent setup — run this once or anytime. */
function setupTriggers() {
  // Choose hours that avoid your peak usage; change if you prefer.
  // These are *approximate*; Apps Script may shift by a few minutes.
  _ensureDailyTrigger_('kickoffTranscriptsIndexV2', 6); // 06:00 UTC daily
  _ensureDailyTrigger_('inventoryWorker_',          7); // 07:00 UTC daily

  return listTriggers();
}

/** Inspect triggers. */
function listTriggers() {
  const rows = ScriptApp.getProjectTriggers().map(t => ({
    handler: t.getHandlerFunction(),
    type: t.getTriggerSource(),   // CLOCK
    desc: t.getEventType() || null
  }));
  return _log_(rows);
}

/** Remove all project triggers (safety valve). */
function clearTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  return listTriggers();
}

// ---------- Convenience: status passthrough ----------

/**
 * showStatusNow — quick passthrough to your indexer’s showStatus(),
 * so you can bind this to a Run menu item for a one-click beacon check.
 */
function showStatusNow() {
  if (typeof showStatus === 'function') {
    return _log_(showStatus());
  }
  return _log_({ error: 'showStatus() not found. Ensure Transcripts_Indexer.gs is included.' });
}
