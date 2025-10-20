/************************************************************
 * YFL — Knowledge Indexer (pump-safe) — 2025-10-20
 * - Scans /Your Friend Logan/ChatGPT_Assets/Knowledge
 * - Builds Knowledge__INDEX__LATEST.csv in /Start_Here
 * - Pump worker (~4.5 min) with backoff + locking
 ************************************************************/

var KI = {
  DO_WRITE: true,                        // set false to dry-run
  PATHS: {
    ROOT:       'Your Friend Logan/ChatGPT_Assets/Knowledge',
    START_HERE: 'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here'
  },
  CSV_FIELDS: ['id','title','mimeType','modifiedDate','fileSize','alternateLink'],
  PAGE: { FOLDER_BATCH: 1000 },          // per pump cycle
  PUMP_MS: 4.5 * 60 * 1000               // ~4.5 minutes
};

/** Entrypoint — queues or runs the worker. */
function kickoffKnowledgeIndexV1() {
  var s = _state('init');               // fresh state
  s.started = new Date().toISOString();
  s.rows    = [];
  s.stack   = [];                       // DFS stack of folder IDs
  s.phase   = 'scan';
  _save(s);

  // seed the stack
  var root = _findFolderByPath_(KI.PATHS.ROOT);
  if (!root) throw new Error("Knowledge root not found at path: " + KI.PATHS.ROOT);
  s.stack.push(root.getId());
  _save(s);

  knowledgeWorker_();
}

/** Pump worker (~4.5 min), DFS over folders, collects rows. */
function knowledgeWorker_() {
  var start = Date.now();
  var lock  = LockService.getScriptLock();   // prevent overlap
  if (!lock.tryLock(5000)) { _ensurePump_('knowledgeWorker_'); return; }

  try {
    var s = _state();
    while (Date.now() - start < KI.PUMP_MS) {
      if (!s.stack || s.stack.length === 0) break;

      var folderId = s.stack.pop();
      var folder   = DriveApp.getFolderById(folderId);

      // push subfolders
      var sub = folder.getFolders();
      while (sub.hasNext()) { s.stack.push(sub.next().getId()); }
      _save(s);

      // collect files
      var files = folder.getFiles();
      var processed = 0;
      while (files.hasNext()) {
        var f = files.next();
        s.rows.push(_rowForFile_(f));
        processed++;
        if (processed % 100 === 0) _save(s);
        if (Date.now() - start >= KI.PUMP_MS) break;
      }
      _save(s);

      if (Date.now() - start >= KI.PUMP_MS) break;
    }

    // continue or finalize
    if (s.stack && s.stack.length > 0) {
      _ensurePump_('knowledgeWorker_');        // continue soon
    } else {
      s.phase = 'finalize';
      _save(s);
      _finalizeKnowledgeCsv_();
    }
  } finally {
    lock.releaseLock();
  }
}

/** Build a row for a Drive file, computing size for Google types via export. */
function _rowForFile_(file) {
  var id   = file.getId();
  var name = file.getName();
  var mime = file.getMimeType();
  var mod  = file.getLastUpdated().toISOString();
  var size = 0;
  var link = 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk';

  // Google-native files need export to estimate bytes.
  if (mime.indexOf('application/vnd.google-apps') === 0) {
    var exportMime = (mime === 'application/vnd.google-apps.spreadsheet') ? 'text/csv' : 'text/plain';
    size = _withBackoff_(function () {
      var url = 'https://www.googleapis.com/drive/v3/files/' + id +
                '/export?mimeType=' + encodeURIComponent(exportMime) + '&alt=media'; // alt=media for media stream
      var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
      return res.getBlob().getBytes().length;
    });
  } else {
    // Non-Google files
    try {
      size = file.getSize();
      if (size == null || size === 0) size = file.getBlob().getBytes().length;
    } catch (e) {
      size = 0;
    }
  }

  return {
    id: id,
    title: name,
    mimeType: mime,
    modifiedDate: mod,
    fileSize: String(size),
    alternateLink: link
  };
}

/** Finalize CSV and write to Start_Here. */
function _finalizeKnowledgeCsv_() {
  var s = _state();
  var header = KI.CSV_FIELDS.join(',');
  var lines  = s.rows.map(function (r) { return KI.CSV_FIELDS.map(function (k) { return _csv(r[k]); }).join(','); });
  var csv    = [header].concat(lines).join('\n');

  if (!KI.DO_WRITE) return;

  var startHere = _findFolderByPath_(KI.PATHS.START_HERE);
  if (!startHere) throw new Error("Start_Here path not found: " + KI.PATHS.START_HERE);

  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  _upsert_(startHere, 'Knowledge__INDEX__LATEST.csv', csv, MimeType.CSV);
  startHere.createFile('Knowledge__INDEX__' + ts + '.csv', csv, MimeType.CSV);
}

/* -------------------------- Helpers -------------------------- */

function _csv(v) {
  var s = (v == null) ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function _withBackoff_(fn, opt) {
  opt = opt || {};
  var max = opt.max || 6, wait = opt.wait || 500;
  for (var i = 0; i < max; i++) {
    try { return fn(); } catch (e) {
      if (i === max - 1) throw e;
      Utilities.sleep(wait + Math.floor(Math.random() * 250));
      wait = Math.min(wait * 2, 8000);
    }
  }
}

function _ensurePump_(handlerName) {
  // remove any existing pump for this handler, then schedule soon
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger(handlerName).timeBased().after(10 * 1000).create(); // run again ~10s later
}

function _clearPump_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}

/** Resolve a folder by a "A/B/C" path (DriveApp root). */
function _findFolderByPath_(path) {
  var segs = (path || '').split('/').filter(String);
  var cursor = DriveApp.getRootFolder();
  for (var i = 0; i < segs.length; i++) {
    var iter = cursor.getFoldersByName(segs[i]);
    if (!iter.hasNext()) return null;
    cursor = iter.next();
  }
  return cursor;
}

/** Replace-or-create a file in a folder. */
function _upsert_(folder, name, content, mimeType) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { it.next().setTrashed(true); }
  folder.createFile(name, content, mimeType || MimeType.CSV);
}

/** JSON state stored in Script Properties. */
function _state(init) {
  var key = 'KI_STATE';
  var sp  = PropertiesService.getScriptProperties();
  if (init === 'init') { sp.deleteProperty(key); return {}; }
  var raw = sp.getProperty(key);
  return raw ? JSON.parse(raw) : {};
}
function _save(obj) {
  PropertiesService.getScriptProperties().setProperty('KI_STATE', JSON.stringify(obj || {}));
}
