/**
 * Ops Toolkit 10 — Triggers
 * - Time-based triggers using ScriptApp ClockTriggerBuilder
 * - Idempotent: re-running setup cleans/duplicates safely
 * - Daily runs default to 06:00 (Transcripts) and 07:00 (Inventory)
 *
 * Notes:
 * - atHour(hour) + everyDays(1) creates a daily time-driven trigger.
 * - Hours are interpreted in the script’s time zone (set in appsscript.json).
 */

// ---------- Utilities ----------

/** Return a map of current triggers keyed by handler name. */
function _getTriggersByHandler_() {
  const out = {};
  ScriptApp.getProjectTriggers().forEach(t => {
    const h = t.getHandlerFunction();
    if (!out[h]) out[h] = [];
    out[h].push(t);
  });
  return out;
}

/** Delete all existing triggers for a given handler. */
function _deleteTriggersFor_(handler) {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** Ensure exactly one daily trigger exists for handler at a given hour. */
function _ensureDailyTrigger_(handler, hour /*0–23*/) {
  _deleteTriggersFor_(handler);
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hour)     // hour in project time zone
    .everyDays(1)     // run daily
    .create();
}

/** Pretty JSON logger + return helper. */
function _log_(obj) {
  Logger.log(JSON.stringify(obj, null, 2));
  return obj;
}

// ---------- Public: setup / list / clear ----------

/**
 * Idempotent setup — safe to run anytime.
 * Adjust the hours if you prefer a different window.
 */
function setupTriggers() {
  // You said you’re usually done 5–10 AM; we’ll run inside that window.
  const TRANSCRIPTS_HOUR = 6; // 06:00 local (project timezone)
  const INVENTORY_HOUR   = 7; // 07:00 local

  _ensureDailyTrigger_('kickoffTranscriptsIndexV2', TRANSCRIPTS_HOUR);
  _ensureDailyTrigger_('inventoryWorker_',          INVENTORY_HOUR);

  return listTriggers(); // echo current state
}

/** List triggers keyed by handler, for quick inspection. */
function listTriggers() {
  const by = _getTriggersByHandler_();
  const rows = Object.keys(by).sort().map(h => ({
    handler: h,
    type: 'CLOCK',
    count: by[h].length
  }));
  return _log_(rows);
}

/** Remove *all* time-driven triggers in this project. */
function clearTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  return _log_({ ok: true, cleared: true });
}
