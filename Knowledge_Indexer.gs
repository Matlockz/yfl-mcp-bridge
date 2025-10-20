/** ********************************************************************
 * Knowledge Indexer v1 (pump-safe, resumable)
 * - Crawls:  /Your Friend Logan/ChatGPT_Assets/Knowledge
 * - Writes:  WORK CSV in /Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here
 * - Final:   Knowledge__INDEX__YYYY-MM-DD.csv + Knowledge__INDEX__LATEST.csv
 * - Runtime: pumps for ~4.5 minutes, then self-schedules next burst
 * ********************************************************************/

var KI = {
  DO_WRITE: true, // flip to false for dry run
  ROOT_PATH: 'Your Friend Logan/ChatGPT_Assets/Knowledge',
  START_HERE_PATH: 'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here',
  STOP_EARLY_MS: (4 * 60 * 1000) + 30 * 1000, // stop ~4.5 min to avoid 6-min hard cap
  CSV_HEADER: 'id,title,mimeType,modifiedTime,size,link\n'
};

/** Entry — seed state and enqueue first pump. */
function kickoffKnowledgeIndexV1() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var state = _loadState_();
    if (state && state.running) {
      Logger.log('Knowledge index already running; skipping kickoff.');
      return;
    }

    var root = _findFolderByPath_(KI.ROOT_PATH);
    if (!root) throw new Error('Root path not found: ' + KI.ROOT_PATH);

    var startHere = _findFolderByPath_(KI.START_HERE_PATH);
    if (!startHere) throw new Error('Start_Here path not found: ' + KI.START_HERE_PATH);

    // Create WORK CSV in Start_Here
    var workFile = startHere.createFile('Knowledge__INDEX__WORK.csv', KI.CSV_HEADER, 'text/csv');

    var s = {
      running: true,
      started: new Date().toISOString(),
      rootId: root.getId(),
      queue: [root.getId()],      // folders to crawl
      workFileId: workFile.getId(),
      processed: 0
    };
    _saveState_(s);
  } finally {
    lock.releaseLock();
  }
  _enqueuePump_(10000); // start in ~10s
}

/** Pump — process until near the time limit, then reschedule. */
function pumpKnowledgeIndexV1_() {
  var stopBy = Date.now() + KI.STOP_EARLY_MS;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { _enqueuePump_(30000); return; } // try again in 30s

  try {
    var s = _loadState_();
    if (!s || !s.running) { Logger.log('No knowledge indexing job in progress.'); return; }

    var appended = [];

    while (Date.now() < stopBy && s.queue.length > 0) {
      var folderId = s.queue.shift();
      var fold = DriveApp.getFolderById(folderId);

      // Files in this folder
      var files = fold.getFiles();
      while (Date.now() < stopBy && files.hasNext()) {
        var f = files.next();
        if (f.isTrashed()) continue;
        if (f.getMimeType() === MimeType.FOLDER) continue; // guard

        appended.push(_csvRow_(f));
        s.processed++;

        // Periodically flush to the file so we don't build a huge string in memory
        if (appended.length >= 200) {
          _appendToFile_(s.workFileId, appended.join(''));
          appended = [];
        }
      }

      // Sub-folders -> push into queue (BFS)
      var subs = fold.getFolders();
      while (Date.now() < stopBy && subs.hasNext()) {
        var sf = subs.next();
        if (!sf.isTrashed()) s.queue.push(sf.getId());
      }

      if (Date.now() >= stopBy) break; // hit our time budget
    }

    if (appended.length) _appendToFile_(s.workFileId, appended.join(''));

    if (s.queue.length > 0) {
      _saveState_(s);
      _enqueuePump_(10000); // continue in ~10s
    } else {
      // Finalize
      _finalize_(s.workFileId);
      _clearState_();
      Logger.log('Knowledge index complete. Files: ' + s.processed);
    }
  } finally {
    lock.releaseLock();
  }
}

/** -------- Helpers -------------------------------------------------- */

function _appendToFile_(fileId, text) {
  if (!KI.DO_WRITE) return;
  var file = DriveApp.getFileById(fileId);
  var prev = file.getBlob().getDataAsString('UTF-8');
  file.setContent(prev + text);
}

function _csvRow_(f) {
  var id = f.getId();
  var title = _csvEscape_(f.getName());
  var mt = f.getMimeType();
  var when = Utilities.formatDate(f.getLastUpdated(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var size = f.getSize() || '';
  var link = _csvEscape_(f.getUrl());
  return id + ',' + title + ',' + mt + ',' + when + ',' + size + ',' + link + '\n';
}

function _csvEscape_(s) {
  if (s === null || s === undefined) return '""';
  var t = String(s).replace(/"/g, '""').replace(/\r?\n/g, ' ');
  return '"' + t + '"';
}

function _finalize_(workFileId) {
  if (!KI.DO_WRITE) return;
  var work = DriveApp.getFileById(workFileId);

  var startHere = _findFolderByPath_(KI.START_HERE_PATH) || DriveApp.getRootFolder();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Dated copy
  var dated = work.makeCopy('Knowledge__INDEX__' + stamp + '.csv', startHere);

  // Refresh LATEST: trash any existing, then copy as LATEST
  var it = DriveApp.searchFiles('title = "Knowledge__INDEX__LATEST.csv" and trashed = false');
  while (it.hasNext()) { it.next().setTrashed(true); }
  work.makeCopy('Knowledge__INDEX__LATEST.csv', startHere);

  // Optionally trash the work file
  work.setTrashed(true);

  Logger.log('Finalized: ' + dated.getName());
}

function _enqueuePump_(ms) {
  // Clean up older pump triggers for this handler
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction && triggers[i].getHandlerFunction() === 'pumpKnowledgeIndexV1_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('pumpKnowledgeIndexV1_').timeBased().after(ms).create(); // one-shot
}

function _findFolderByPath_(path) {
  // Split by '/', walk from My Drive root
  var parts = path.split('/');
  var cur = DriveApp.getRootFolder();
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim();
    if (!name) continue;
    var it = cur.getFoldersByName(name);
    if (!it.hasNext()) return null;
    cur = it.next();
  }
  return cur;
}

/** State persisted in ScriptProperties */
function _loadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty('KI_V1_STATE');
  return raw ? JSON.parse(raw) : null;
}
function _saveState_(obj) {
  PropertiesService.getScriptProperties().setProperty('KI_V1_STATE', JSON.stringify(obj));
}
function _clearState_() {
  PropertiesService.getScriptProperties().deleteProperty('KI_V1_STATE');
}

/** Debug/status helper (optional quick peek in logs) */
function showKnowledgeStatus() {
  var s = _loadState_();
  Logger.log(s ? JSON.stringify(s, null, 2) : 'No job state.');
}
