/** **********************************************************************
 * YFL — Knowledge Indexer (pump‑safe, resumable) — 2025‑10‑20
 * - Scans a target Knowledge folder, captures lightweight metadata,
 * - Appends rows into a temporary Google Sheet during the pump,
 * - On completion, exports the sheet => Knowledge__INDEX__LATEST.csv.
 *
 * Requirements:
 *  - Advanced Drive API v2 enabled (Resources → Advanced Google services).
 *  - Scopes: Drive, Docs read-only, *Spreadsheets* (to create/append), ScriptApp.
 *  - This file is self‑contained: includes backoff, locks, path resolution.
 *
 * Notes:
 *  - Apps Script executions are ~6 minutes max per run. We pump in slices
 *    and re-schedule until done, using time-based triggers. See quotas. 
 *  - We avoid Drive “append” by buffering rows to a Sheet, then export. 
 * **********************************************************************/

var KI = {
  DO_WRITE: true, // false = dry run (logs only)
  PATHS: {
    // Where to write the LATEST CSV + staging sheet
    START_HERE: 'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here',
    // Which folder tree to scan for "Knowledge" (narrow this to keep runs small)
    ROOT:       'Your Friend Logan/ChatGPT_Assets/Knowledge'
  },
  PAGE_SIZE: 200,                          // Drive.Files.list page size
  FIELDS: 'items(id,title,mimeType,modifiedDate,fileSize,alternateLink,webViewLink),nextPageToken',
  CSV_NAME: 'Knowledge__INDEX__LATEST.csv',
  STAGING_PREFIX: 'Knowledge__INDEX__WORKING__'
};

// ---- Entry points ------------------------------------------------------

function kickoffKnowledgeIndexV1() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;   // another run is active; bail

  try {
    _clearPump_('knowledgeWorker_');      // remove stale pump triggers

    // Resolve target folders
    var startHere = _findFolderByPath_(KI.PATHS.START_HERE);
    var root      = _findFolderByPath_(KI.PATHS.ROOT);
    if (!startHere) throw new Error('START_HERE not found: ' + KI.PATHS.START_HERE);
    if (!root)      throw new Error('ROOT not found: ' + KI.PATHS.ROOT);

    // Create fresh staging Sheet
    var stagingName = KI.STAGING_PREFIX + new Date().toISOString().replace(/[:.]/g,'-');
    var ss = SpreadsheetApp.create(stagingName);
    var sheet = ss.getActiveSheet();
    sheet.clear();
    sheet.appendRow(['id','title','mimeType','modifiedDate','fileSize','alternateLink']);

    // Move staging Sheet into START_HERE
    DriveApp.getFileById(ss.getId()).moveTo(startHere);

    // Seed state
    var state = {
      pageToken: null,
      written:   0,
      rootId:    root.getId(),
      stagingId: ss.getId(),
      startIso:  new Date().toISOString()
    };
    PropertiesService.getScriptProperties().setProperty('KI_STATE', JSON.stringify(state));

    // Kick the first worker slice now
    return knowledgeWorker_();
  } finally {
    lock.releaseLock();
  }
}

function knowledgeWorker_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;

  try {
    var prop = PropertiesService.getScriptProperties();
    var state = JSON.parse(prop.getProperty('KI_STATE') || '{}');
    if (!state.stagingId || !state.rootId) {
      Logger.log('No state; call kickoffKnowledgeIndexV1 first.');
      return;
    }

    var deadlineMs = Date.now() + (5 * 60 * 1000) - 30000; // ~5m minus 30s guard
    var ss = SpreadsheetApp.openById(state.stagingId);
    var sheet = ss.getActiveSheet();

    while (Date.now() < deadlineMs) {
      var resp = Drive.Files.list({
        q: "'" + state.rootId + "' in parents and trashed = false",
        maxResults: KI.PAGE_SIZE,
        pageToken: state.pageToken || null,
        fields: KI.FIELDS,
        orderBy: 'modifiedDate desc'
      });

      var items = (resp && resp.items) ? resp.items : [];
      if (items.length === 0) {
        // No more pages -> finalize
        _finalizeKnowledgeCsv_(state);
        return;
      }

      // Build rows and append to sheet in a single batch
      var rows = items.map(function(it) {
        return [
          it.id || '',
          it.title || '',
          it.mimeType || '',
          it.modifiedDate || '',
          it.fileSize || '',
          (it.alternateLink || it.webViewLink || '')
        ];
      });

      // Append in chunks to avoid 50k cell limits per call
      _appendRows_(sheet, rows);
      state.written += rows.length;

      // Next page?
      state.pageToken = resp.nextPageToken || null;
      prop.setProperty('KI_STATE', JSON.stringify(state));

      if (!state.pageToken) {
        _finalizeKnowledgeCsv_(state);
        return;
      }
    }

    // Out of time → schedule the next pump in ~1 minute
    ScriptApp.newTrigger('knowledgeWorker_').timeBased().after(60 * 1000).create();
  } finally {
    lock.releaseLock();
  }
}

// ---- Helpers -----------------------------------------------------------

function _appendRows_(sheet, rows) {
  var i = 0;
  var BATCH = 2000; // rows per setValues batch (tune if needed)
  while (i < rows.length) {
    var chunk = rows.slice(i, i + BATCH);
    var start = sheet.getLastRow() + 1;
    var rng = sheet.getRange(start, 1, chunk.length, 6);
    rng.setValues(chunk);
    i += BATCH;
  }
}

function _finalizeKnowledgeCsv_(state) {
  var startHere = _findFolderByPath_(KI.PATHS.START_HERE);
  var ssId = state.stagingId;

  // Export first sheet as CSV (Drive.Files.export produces text/csv for Sheets)
  var csvBlob = _withBackoff_(function() {
    return Drive.Files.export(ssId, 'text/csv').getBlob();
  });

  if (KI.DO_WRITE) {
    // Remove any older LATEST file(s)
    var existing = startHere.getFilesByName(KI.CSV_NAME);
    while (existing.hasNext()) existing.next().setTrashed(true);

    // Create fresh LATEST
    startHere.createFile(csvBlob.setName(KI.CSV_NAME));
  }

  // Clean up staging
  try { DriveApp.getFileById(ssId).setTrashed(true); } catch (e) {}

  // Clear state
  PropertiesService.getScriptProperties().deleteProperty('KI_STATE');
  Logger.log(JSON.stringify({ ok:true, written: state.written, out: KI.CSV_NAME }));
}

/** Primitive exponential backoff (0.5s → 8s) with jitter. */
function _withBackoff_(fn) {
  var delay = 500;
  for (var i = 0; i < 6; i++) {
    try { return fn(); }
    catch (e) {
      Utilities.sleep(delay + Math.floor(Math.random() * 200));
      delay = Math.min(delay * 2, 8000);
      if (i === 5) throw e;
    }
  }
}

function _clearPump_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function _findFolderByPath_(path) {
  // Very simple path resolver by name (My Drive only).
  var segs = (path || '').split('/').filter(String);
  var cursor = DriveApp.getRootFolder();
  for (var i = 0; i < segs.length; i++) {
    var found = null;
    var iter = cursor.getFoldersByName(segs[i]);
    while (iter.hasNext()) {
      var f = iter.next();
      found = f; break; // take the first match
    }
    if (!found) return null;
    cursor = found;
  }
  return cursor;
}
