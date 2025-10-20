/** ********************************************************************
 * YFL — Knowledge Indexer (v1)  —  2025-10-20
 * - Walks the Knowledge tree and emits:
 *     Knowledge__INDEX__LATEST.csv  (+ dated snapshot)
 * - Safe under Apps Script limits via a 5‑minute "pump".
 * - Exports Google Docs/Sheets bodies only if DO_CACHE=true (optional).
 *
 *  Requirements:
 *   - Scopes: Drive, Drive.Readonly, Docs.Readonly, Sheets.Readonly,
 *             ScriptApp, Script external requests (for UrlFetch)
 *   - Advanced service: Drive API v2 enabled (used sparingly)
 *
 *  Notes:
 *   - Google file export uses UrlFetch + OAuth Bearer + alt=media per Drive v3.
 *     Ref: Drive API “Manage downloads” (files.get vs files.export). 
 * ********************************************************************/

var KI = {
  DO_WRITE:  true,      // set false to dry‑run
  DO_CACHE:  false,     // set true to also export/cache bodies
  PATHS: {
    START_HERE:  'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here',
    ROOT:        'Your Friend Logan/ChatGPT_Assets/Knowledge'
  },
  PAGE:       { FOLDER_BATCH: 1000 },  // per pump cycle
  CSV_FIELDS: ['id','title','mimeType','modifiedDate','fileSize','alternateLink'],
  PUMP_MS:    4.5 * 60 * 1000           // ~4.5 minutes safety budget
};

/** Entrypoint — queues or runs the worker. */
function kickoffKnowledgeIndexV1() {
  var s = _state('init');
  s.started = new Date().toISOString();
  s.rows = s.rows || [];
  s.stack = s.stack || [];     // DFS stack of folder IDs to process
  s.phase = s.phase || 'scan'; // 'scan' → 'finalize'
  _save(s);

  // seed the stack
  if (!s.seeded) {
    var root = _findFolderByPath_(KI.PATHS.ROOT);
    if (!root) throw new Error("Knowledge root not found at path: " + KI.PATHS.ROOT);
    s.stack = [ root.getId() ];
    s.seeded = true;
    _save(s);
  }
  knowledgeWorker_();
}

function knowledgeWorker_() {
  var start = Date.now();
  var s = _state();

  if (s.phase === 'scan') {
    var out = s.rows || [];
    var processed = 0;

    while (s.stack.length && (Date.now() - start) < KI.PUMP_MS) {
      var folderId = s.stack.pop();
      var folder   = DriveApp.getFolderById(folderId);

      // enqueue children folders (DFS)
      var sub = folder.getFolders();
      while (sub.hasNext()) {
        s.stack.push(sub.next().getId());
      }

      // collect files
      var iter = folder.getFiles();
      while (iter.hasNext()) {
        var f = iter.next();
        out.push(_rowOf_(f));
        processed++;
        if ((Date.now() - start) >= KI.PUMP_MS) break;
      }
    }

    s.rows = out;
    _save(s);

    if (s.stack.length && (Date.now() - start) >= KI.PUMP_MS) {
      // re‑queue worker soon
      ScriptApp.newTrigger('knowledgeWorker_').timeBased().after(30 * 1000).create();
      return;
    }

    if (!s.stack.length) {
      s.phase = 'finalize';
      _save(s);
    }
  }

  if (s.phase === 'finalize') {
    _finalizeKnowledgeCsv_(s);
    _clearPump_('knowledgeWorker_');
    _state('clear');
  }
}

/** Build CSV, write beacons; optional: export/cache bodies. */
function _finalizeKnowledgeCsv_(s) {
  if (!KI.DO_WRITE) return;

  var header = KI.CSV_FIELDS.join(',');
  var lines  = [header];

  for (var i = 0; i < s.rows.length; i++) {
    var r = s.rows[i];
    lines.push(_csvLine_(r, KI.CSV_FIELDS));

    // optional body cache
    if (KI.DO_CACHE) {
      try {
        var bodyTxt = _exportBodyText_(r.id, r.mimeType);
        // Optionally: write to a cache folder or a Drive file per id.
        // (Left as a placeholder for when we enable DO_CACHE)
      } catch (e) {
        Logger.log('cache export failed for ' + r.id + ': ' + e);
      }
    }
  }

  var csv = lines.join('\n');

  var startHere = _findFolderByPath_(KI.PATHS.START_HERE);
  if (!startHere) throw new Error('START_HERE not found: ' + KI.PATHS.START_HERE);

  var dateTag = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var dated   = startHere.createFile('Knowledge__INDEX__' + dateTag + '.csv', csv, MimeType.CSV);

  // replace LATEST beacon
  var existing = startHere.getFilesByName('Knowledge__INDEX__LATEST.csv');
  while (existing.hasNext()) { existing.next().setTrashed(true); }
  startHere.createFile('Knowledge__INDEX__LATEST.csv', csv, MimeType.CSV);

  Logger.log(JSON.stringify({
    rows: s.rows.length,
    datedId: dated.getId(),
    latest: 'Knowledge__INDEX__LATEST.csv'
  }, null, 2));
}

/** Convert DriveApp File → CSV row object. */
function _rowOf_(file) {
  var id   = file.getId();
  var name = file.getName();
  var mt   = file.getMimeType();
  var mod  = file.getLastUpdated().toISOString ? file.getLastUpdated().toISOString()
                                               : Utilities.formatDate(file.getLastUpdated(),
                                                    Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var size = file.getSize(); // may be 0 for Google types
  var link = 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk';

  return {
    id: id,
    title: name,
    mimeType: mt,
    modifiedDate: mod,
    fileSize: size,
    alternateLink: link
  };
}

/** Robust CSV line (quotes, commas, CR/LF safe). */
function _csvLine_(obj, fields) {
  var cells = [];
  for (var i = 0; i < fields.length; i++) {
    var v = obj[fields[i]];
    if (v === null || v === undefined) { v = ''; }
    v = String(v);
    v = v.replace(/"/g, '""');       // escape quotes
    // wrap if contains comma, quote, or CR/LF
    if (/[",\r\n]/.test(v)) { v = '"' + v + '"'; }
    cells.push(v);
  }
  return cells.join(',');
}

/** Export body text for Google Docs/Sheets using Drive v3 HTTP. */
function _exportBodyText_(id, mimeType) {
  // Docs → text/plain; Sheets → text/csv; others → blob->string
  if (mimeType === 'application/vnd.google-apps.document') {
    return _driveExport_(id, 'text/plain'); // body text
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return _driveExport_(id, 'text/csv');   // first sheet
  }
  // Non‑Google: simple blob read
  return DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8');
}

/** Drive v3 export via UrlFetch + OAuth Bearer + alt=media. */
function _driveExport_(id, outMime) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
            '/export?mimeType=' + encodeURIComponent(outMime);
  var res = _withBackoff_(function () {
    return UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Export failed ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return res.getBlob().getDataAsString('UTF-8');
}

/** Exponential backoff wrapper with small jitter. */
function _withBackoff_(fn, retries, baseMs) {
  retries = (retries === undefined) ? 5 : retries;
  baseMs  = (baseMs  === undefined) ? 300 : baseMs;
  var attempt = 0, lastErr = null;
  while (attempt <= retries) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      var sleep = Math.min(10000, baseMs * Math.pow(2, attempt)) + Math.floor(Math.random()*250);
      Utilities.sleep(sleep);
      attempt++;
    }
  }
  throw lastErr || new Error('Backoff exceeded');
}

/** Stop any queued worker triggers by handler name. */
function _clearPump_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) { ScriptApp.deleteTrigger(t); }
  });
}

/** Resolve “/path/like/this” inside My Drive by folder names. */
function _findFolderByPath_(path) {
  var segs = (path || '').split('/').filter(String);
  var cursor = DriveApp.getRootFolder();
  for (var i = 0; i < segs.length; i++) {
    var found = null;
    var iter = cursor.getFoldersByName(segs[i]);
    while (iter.hasNext()) { found = iter.next(); break; }
    if (!found) return null;
    cursor = found;
  }
  return cursor;
}

/** Stable state helpers (ScriptProperties). */
function _state(mode) {
  var p = PropertiesService.getScriptProperties();
  if (mode === 'clear') { p.deleteProperty('KI_STATE'); return; }
  if (mode === 'init')  { p.setProperty('KI_STATE', JSON.stringify({})); }
  var raw = p.getProperty('KI_STATE');
  return raw ? JSON.parse(raw) : {};
}
