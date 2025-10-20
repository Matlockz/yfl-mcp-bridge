/*************************************************************
 * Trigger helpers (idempotent)
 * - Sets up daily triggers at local hours (script timezone)
 * - Provides listTriggers() for sanity
 *************************************************************/

function _ensureDailyTriggerLocal_(handler, hourLocal) {
  // Remove existing triggers for this handler
  var trigs = ScriptApp.getProjectTriggers();
  for (var i=0; i<trigs.length; i++) {
    if (trigs[i].getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigs[i]);
    }
  }
  // Create at the specified local hour
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hourLocal)     // script timezone (File → Project settings)
    .everyDays(1)
    .create();
}

/** List all current triggers (for sanity). */
function listTriggers() {
  var out = [];
  var trigs = ScriptApp.getProjectTriggers();
  for (var i=0; i<trigs.length; i++) {
    var t = trigs[i];
    out.push({
      handler: t.getHandlerFunction(),
      type: t.getTriggerSource() // 'CLOCK' for time-based
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Idempotent setup — safe to re-run anytime. */
function setupTriggers() {
  // You said you’re mostly done 5–10am; run early morning
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7);  // ~07:00 local
  _ensureDailyTriggerLocal_('inventoryWorker_',            8);  // ~08:00 local
  _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1',     9);  // ~09:00 local
  return listTriggers();
}
