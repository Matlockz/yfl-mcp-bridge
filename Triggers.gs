/** ********************************************************************
 * Triggers — idempotent setup + helpers (no modern syntax)
 * ********************************************************************/

function _ensureDailyTriggerLocal_(handler, hourLocal) {
  // Remove existing triggers for this handler
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    if (t.getHandlerFunction && t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  }

  // Daily at the given hour in the script's timezone
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hourLocal)
    .everyDays(1)
    .create();
}

/** Pretty JSON log helper. */
function _log_(_obj) {
  Logger.log(JSON.stringify(_obj, null, 2));
  return _obj;
}

/** Idempotent setup — safe to re-run anytime. */
function setupTriggers() {
  // You said you’re mostly done 5–10am; run at 7:00 and 8:00 local.
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7); // 07:00 local
  _ensureDailyTriggerLocal_('inventoryWorker_',             8); // 08:00 local
  _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1',      9); // 09:00 local
  return listTriggers();
}

/** List all current triggers (for sanity). */
function listTriggers() {
  var out = [];
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    var t = ts[i];
    out.push({
      handler: t.getHandlerFunction(),
      type: t.getTriggerSource() // 'CLOCK' for time-based
    });
  }
  return _log_(out);
}
