/**
 * Triggers: daily indexers for Ops Toolkit 10 (script timezone applies).
 * - Uses ScriptApp time-based triggers (ClockTriggerBuilder).
 * - Idempotent (deletes/recreates by handler).
 * Docs: https://developers.google.com/apps-script/reference/script/clock-trigger-builder  (script timezone) 
 */

//////////////////// Utilities ////////////////////

/** Return array of current triggers keyed by handler. */
function _getTriggersByHandler_() {
  const out = {};
  ScriptApp.getProjectTriggers().forEach(t => {
    const h = t.getHandlerFunction();
    if (!out[h]) out[h] = [];
    out[h].push(t);
  });
  return out;
}

/** Create or replace a single daily trigger for a handler at a local hour. */
function _ensureDailyTriggerLocal_(handler, hourLocal) {
  // Remove existing triggers for this handler
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
  // Recreate at desired hour (script timezone)
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hourLocal)   // script's timezone
    .everyDays(1)
    .create();
}

/** Pretty JSON log helper. */
function _log_(obj) {
  Logger.log(JSON.stringify(obj, null, 2));
  return obj;
}

//////////////////// Public: setup / list / clear //////////////////

/** Idempotent setup — safe to re-run anytime. */
function setupTriggers() {
  // You said you’re mostly done 5–10am; run at 7:00 and 8:00 local.
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7);  // 07:00 local
  _ensureDailyTriggerLocal_('inventoryWorker_',           8);  // 08:00 local
  // Optional: add the Knowledge indexer once you’re ready:
  // _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1', 9);  // 09:00 local
  return listTriggers();
}

/** List all current triggers (for sanity). */
function listTriggers() {
  const out = [];
  ScriptApp.getProjectTriggers().forEach(t => {
    out.push({
      handler: t.getHandlerFunction(),
      type: t.getTriggerSource(),  // 'CLOCK' for time-based
      desc: null
    });
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Clear all time triggers (if needed). */
function clearTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  return listTriggers();
}
