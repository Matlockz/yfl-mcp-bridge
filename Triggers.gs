/************************************************************
 * Triggers — idempotent setup for daily runs
 ************************************************************/

function _ensureDailyTriggerLocal_(handler, hourLocal) {
  // Remove existing triggers for this handler.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });

  // Create it at specified local hour.
  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)              // daily
    .atHour(hourLocal)         // local script timezone
    .create();
}

function setupTriggers() {
  // You said you're mostly done 5–10am; schedule around that window.
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7); // 07:00 local
  _ensureDailyTriggerLocal_('inventoryWorker_',            8); // 08:00 local
  _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1',     9); // 09:00 local
  return listTriggers();
}

function listTriggers() {
  var out = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    out.push({
      handler: t.getHandlerFunction(),
      type: t.getTriggerSource()  // 'CLOCK' for time-based
    });
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
