/** *****************************************************************
 * Ops Toolkit — Triggers + Admin glue            (2025‑10‑20)
 * Purpose:
 *  - Nightly build of INDEX + CHUNKS (time‑driven trigger)
 *  - One‑shot helpers you can run from the IDE Run menu
 *
 * Requires:
 *  - ScriptApp (built‑in)
 *  - Your existing kickoffTranscriptsIndexV2() in Transcripts_Indexer.gs
 *******************************************************************/

/** Run once to (re)create the time‑driven trigger. */
function setupTriggers() {
  const FN = 'kickoffTranscriptsIndexV2';
  const TZ = Session.getScriptTimeZone() || 'America/Los_Angeles';

  // Remove any old time‑driven triggers for this handler to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getEventType() === ScriptApp.EventType.CLOCK && t.getHandlerFunction() === FN)
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Create a daily trigger ~at the chosen hour in your script time zone.
  // Note: Apps Script schedules inside the hour; minute is approximate by design.
  ScriptApp.newTrigger(FN)
    .timeBased()
    .everyDays(1)
    .atHour(3)            // <-- change this hour if you prefer
    .inTimezone(TZ)
    .create();
}

/** See what triggers exist (handy for quick checks). */
function listTriggers() {
  const rows = ScriptApp.getProjectTriggers().map(t => ({
    handler: t.getHandlerFunction(),
    type: String(t.getEventType && t.getEventType()),
    desc: t.getTriggerSourceId ? String(t.getTriggerSourceId()) : ''
  }));
  Logger.log(JSON.stringify(rows, null, 2));
  return rows;
}

/** Remove ALL time‑driven triggers created in this project (surgical reset). */
function nukeTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

/** Manual one‑shot: build INDEX + CHUNKS now (same as what the trigger runs). */
function runNow() {
  return kickoffTranscriptsIndexV2();
}

/** Optional: quick beacon — surfaces LATEST sizes & links in the log. */
function showStatusNow() {
  return showStatus(); // re‑use your existing helper in Transcripts_Indexer.gs
}
