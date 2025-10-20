/** Triggers — idempotent setup / list (safe to run anytime). */

function _ensureDailyTriggerLocal_(handler, hourLocal) {
  // Remove existing triggers for handler
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
  // Create new daily trigger at specified local hour
  ScriptApp.newTrigger(handler).timeBased().atHour(hourLocal).everyDays(1).create();
}

function setupTriggers() {
  // You’re mostly done working 5–10am; suggest: 07:00 / 07:10 / 07:20 local
  _ensureDailyTriggerLocal_('kickoffTranscriptsIndexV2', 7);  // 07:00
  _ensureDailyTriggerLocal_('kickoffKnowledgeIndexV1',  7);  // 07:00 (pump handles slicing)
  _ensureDailyTriggerLocal_('inventoryWorker_',         8);  // 08:00
  return listTriggers();
}

function listTriggers() {
  var out = [];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    out.push({ handler: t.getHandlerFunction(), type: t.getTriggerSource() });
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
