/*************************************************************
 * YFL — Knowledge Indexer (metadata-only, pump-safe) — v1
 * - Scans /Your Friend Logan/ChatGPT_Assets/Knowledge
 * - Emits: Knowledge__INDEX__LATEST.csv (+ dated snapshot)
 * - Resumes across runs (pump ~4.5 minutes), no overlaps
 * - Metadata only (no content export); fast & quota-friendly
 *
 * Requirements:
 *  - Advanced Drive service: ON (Drive v2)
 *  - Scopes: Drive, (optional) Docs.readonly if you later add exports
 *************************************************************/

var KI = {
  PATHS: {
    ROOT:       'Your Friend Logan/ChatGPT_Assets/Knowledge',
    CANON_DIR:  'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here'
  },
  CSV_FIELDS: ['id','title','mimeType','modifiedDate','fileSize','alternateLink'],
  PUMP_MS:   Math.floor(4.5 * 60 * 1000), // ~4.5 min safety budget
  RESUME_MS: 2000                         // schedule next pump soon
};

/** Entrypoint: seeds state then pumps the worker. */
function kickoffKnowledgeIndexV1() {
  var s = _state() || {};
  s.started = (new Date()).toISOString();
  s.rows    = s.rows  || [];
  s.stack   = s.stack || [];
  s.phase   = s.phase || 'scan';
  _save(s);

  if (!s.seeded) {
    var root = _findFolderByPath_(KI.PATHS.ROOT);
    if (!root) throw new Error('Knowledge root not found at path: ' + KI.PATHS.ROOT);
    s.stack  = [ root.getId() ];     // DFS over folder IDs
    s.seeded = true;
    _save(s);
  }
  knowledgeWorker_();
}

/** Pump worker — runs for ~PUMP_MS, persists and reschedules if needed. */
function knowledgeWorker_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;    // a run is already in-flight

  try {
    var started = Date.now();
    var s = _state();
    if (!s) return;

    while (Date.now() - started < KI.PUMP_MS) {
      if (s.phase === 'scan') {
        if (!s.stack || s.stack.length === 0) {
          s.phase = 'finalize';
          _save(s);
          continue;
        }

        var folderId = s.stack.pop();
        var folder   = DriveApp.getFolderById(folderId);

        // Push subfolders (DFS)
        var subIt = folder.getFolders();
        while (subIt.hasNext()) {
          s.stack.push(subIt.next().getId());
        }

        // Collect file metadata rows
        var fileIt = folder.getFiles();
        while (fileIt.hasNext()) {
          var f  = fileIt.next();
          var id = f.getId();
          var row = {
            id: id,
            title: f.getName(),
            mimeType: f.getMimeType(),
            modifiedDate: _isoUtc_(f.getLastUpdated()),
            fileSize: f.getSize() || '',
            alternateLink: 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk'
          };
          s.rows.push(row);
          if (Date.now() - started >= KI.PUMP_MS) break; // respect budget
        }

        _save(s);
        continue;
      }

      if (s.phase === 'finalize') {
        _finalizeKnowledgeCsv_(s.rows || []);
        // reset for next time
        s.finished = (new Date()).toISOString();
        s.rows  = [];
        s.stack = [];
        s.phase = 'done';
        _save(s);
        break;
      }

      break; // 'done'
    }

    // Reschedule if not done
    s = _state();
    if (s && s.phase !== 'done') {
      ScriptApp.newTrigger('knowledgeWorker_')
        .timeBased()
        .after(KI.RESUME_MS)
        .create();
    }
  } finally {
    lock.releaseLock();
  }
}

/* ---------- CSV finalize (no Drive export of content; metadata only) ---------- */

function _finalizeKnowledgeCsv_(rows) {
  // Sort stable by title for consistent diffs
  rows.sort(function(a,b){ return (a.title||'').localeCompare(b.title||''); });

  var header = KI.CSV_FIELDS.join(',');
  var out = [header];

  for (var i=0; i<rows.length; i++) {
    var r = rows[i];
    var line = [
      _q(r.id),
      _q(r.title),
      _q(r.mimeType),
      _q(r.modifiedDate),
      _q(r.fileSize),
      _q(r.alternateLink)
    ].join(',');
    out.push(line);
  }

  var csv = out.join('\n');
  var canon = _findFolderByPath_(KI.PATHS.CANON_DIR);
  if (!canon) throw new Error('Canonical folder not found: ' + KI.PATHS.CANON_DIR);

  // Replace LATEST
  _deleteByName_(canon, 'Knowledge__INDEX__LATEST.csv');
  canon.createFile('Knowledge__INDEX__LATEST.csv', csv, MimeType.CSV);

  // Dated snapshot
  var d = (new Date()).toISOString().slice(0,10); // YYYY-MM-DD
  canon.createFile('Knowledge__INDEX__' + d + '.csv', csv, MimeType.CSV);
}

/* ---------- Small helpers ---------- */

function _isoUtc_(d) {
  return (d && d.toISOString) ? d.toISOString() : (d || '');
}

function _q(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  // Escape quotes, wrap if commas/quotes/newlines
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g,'""') + '"';
  }
  return s;
}

function _deleteByName_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { it.next().setTrashed(true); }
}

function _findFolderByPath_(path) {
  var segs = (path || '').split('/').filter(function(x){ return x; });
  var cursor = DriveApp.getRootFolder();
  for (var i=0; i<segs.length; i++) {
    var it = cursor.getFoldersByName(segs[i]);
    if (!it.hasNext()) return null;
    cursor = it.next(); // take first match
  }
  return cursor;
}

/* ---------- State helpers (ScriptProperties) ---------- */

function _state() {
  var raw = PropertiesService.getScriptProperties().getProperty('ki.state');
  return raw ? JSON.parse(raw) : null;
}

function _save(obj) {
  PropertiesService.getScriptProperties().setProperty('ki.state', JSON.stringify(obj));
}

/* ---------- Status ---------- */

function showKnowledgeStatusNow() {
  var canon = _findFolderByPath_(KI.PATHS.CANON_DIR);
  var info = {};
  if (canon) {
    var latest = canon.getFilesByName('Knowledge__INDEX__LATEST.csv');
    if (latest.hasNext()) {
      var f = latest.next();
      info.knowledgeLatest = {
        name: f.getName(),
        bytes: f.getSize(),
        updated: _isoUtc_(f.getLastUpdated()),
        url: 'https://drive.google.com/file/d/' + f.getId() + '/view?usp=drivesdk'
      };
    }
  }
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/* ---------- Optional: clear any pending pumps for this worker ---------- */
function _clearPump_(handlerName) {
  var trigs = ScriptApp.getProjectTriggers();
  for (var i=0; i<trigs.length; i++) {
    var t = trigs[i];
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
    }
  }
}
