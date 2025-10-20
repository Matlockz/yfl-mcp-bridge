/** Utilities */
function _log(obj){ Logger.log(JSON.stringify(obj,null,2)); }

/** Create or replace a single daily trigger (local hour). */
function _ensureDailyTriggerLocal_(handler, hourLocal){
  // Remove any prior triggers for this handler
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === handler){ ScriptApp.deleteTrigger(t); }
  });
  // Create the new daily trigger at the local hour
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(hourLocal)    // uses the script's timezone
    .everyDays(1)
    .create();
}

/** Idempotent setup — safe anytime. */
function setupTriggers(){
  // You said you’re mostly done 5–10am; let’s run at 07:00/08:00/09:00 local.
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7);
  _ensureDailyTriggerLocal_('inventoryWorker_',          8);
  _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1',   9);
  return listTriggers();
}

/** Show current triggers (sanity). */
function listTriggers(){
  var out = [];
  ScriptApp.getProjectTriggers().forEach(function(t){
    out.push({ handler: t.getHandlerFunction(), type: t.getTriggerSource() });
  });
  _log(out);
  return out;
}
