/**
 * Knowledge Indexer (v1)
 * - Crawls `/Your Friend Logan` (recursively) for exportable text.
 * - Emits beacons in `/Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here`:
 *     - Knowledge__INDEX__LATEST.csv
 *     - Knowledge__CHUNKS__LATEST.csv
 * - Newline-aware chunker: SIZE 6000, OVERLAP 400
 * - Uses Advanced Drive v2 (Drive.Files.export) for Docs/Sheets.
 * - LockService prevents overlap; bounded exponential backoff for export calls.
 * Docs:
 *   Quotas: https://developers.google.com/apps-script/guides/services/quotas
 *   Lock:   https://developers.google.com/apps-script/reference/lock/lock-service
 *   Export: https://developers.google.com/drive/api/guides/ref-export-formats
 */

var KI = {
  DO_WRITE: true,
  PATHS: {
    START_HERE: 'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here',
    ROOT: 'Your Friend Logan'
  },
  CHUNK: { SIZE: 6000, OVERLAP: 400 },
  // Minimal metadata
  FIELDS: 'id,title,mimeType,modifiedDate,fileSize,alternateLink,exportLinks,webViewLink'
};

//////////////////// Helpers: path, folders, backoff, locks ////////////////////

function _getFolderByPath_(path) {
  var parts = path.split('/').filter(Boolean);
  var folder = DriveApp.getRootFolder();
  for (var i = 0; i < parts.length; i++) {
    var it = folder.getFoldersByName(parts[i]);
    if (!it.hasNext()) throw new Error('Folder not found: ' + parts[i] + ' in ' + path);
    folder = it.next();
  }
  return folder;
}

function _withBackoff_(fn) {
  var delay = 500, max = 8; // ~500ms → ~64s
  for (var i = 0; i < max; i++) {
    try { return fn(); }
    catch (e) {
      if (i === max - 1) throw e;
      Utilities.sleep(delay);
      delay = Math.min(15000, Math.floor(delay * 1.8 + Math.random() * 200));
    }
  }
}

function _tryLock_(key, secs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(secs * 1000)) throw new Error('Another run is in progress.');
  return lock;
}

//////////////////// Exporters ////////////////////

function _exportText_(file) {
  var id = file.getId();
  var mime = file.getMimeType();

  // Google Docs
  if (mime === 'application/vnd.google-apps.document') {
    var resp = _withBackoff_(function() {
      return Drive.Files.export(id, 'text/plain');
    });
    return resp.getBlob().getDataAsString('UTF-8');
  }

  // Google Sheets → CSV (first sheet)
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    var resp2 = _withBackoff_(function() {
      return Drive.Files.export(id, 'text/csv');
    });
    return resp2.getBlob().getDataAsString('UTF-8');
  }

  // Plain text or other readable types
  if (mime.indexOf('text/') === 0) {
    return file.getBlob().getDataAsString('UTF-8');
  }

  // Non-exportable (skip)
  return null;
}

function _csvEscape_(s) {
  if (s == null) return '';
  s = String(s);
  if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

//////////////////// Chunker ////////////////////

function _chunkText_(txt, size, overlap) {
  var out = [];
  var step = Math.max(1, size - overlap);
  var pos = 0;
  while (pos < txt.length) {
    var end = Math.min(txt.length, pos + size);
    var slice = txt.substring(pos, end);
    var nl = slice.lastIndexOf('\n');
    if (nl >= 0 && (slice.length - nl) <= 500) {
      slice = slice.substring(0, nl + 1);
      end = pos + slice.length;
    }
    out.push({ start: pos, end: end, length: slice.length });
    if (end === txt.length) break;
    pos = Math.min(txt.length, pos + step);
  }
  return out;
}

//////////////////// Crawl & build ////////////////////

function _walkFolder_(folder, prefix, rows, chunkRows) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var body = null;
    try { body = _exportText_(f); } catch (e) { body = null; }
    var path = prefix + '/' + f.getName();

    rows.push({
      id: f.getId(),
      title: f.getName(),
      mimeType: f.getMimeType(),
      modifiedDate: f.getLastUpdated().toISOString ? f.getLastUpdated().toISOString() : '',
      fileSize: f.getSize ? f.getSize() : '',
      path: path,
      webViewLink: f.getUrl(),
      exportable: body != null
    });

    if (body) {
      var chunks = _chunkText_(body, KI.CHUNK.SIZE, KI.CHUNK.OVERLAP);
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        chunkRows.push({
          id: f.getId(),
          chunkIndex: i,
          start: c.start,
          end: c.end,
          length: c.length,
          path: path
        });
      }
    }
  }

  var sub = folder.getFolders();
  while (sub.hasNext()) {
    var sf = sub.next();
    _walkFolder_(sf, prefix + '/' + sf.getName(), rows, chunkRows);
  }
}

//////////////////// Emit ////////////////////

function _emitCsv_(folder, name, rows, header) {
  var csv = header + '\n' + rows.map(function(r) {
    return Object.keys(r).map(function(k) { return _csvEscape_(r[k]); }).join(',');
  }).join('\n');

  var existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  folder.createFile(name, csv, MimeType.CSV);
}

//////////////////// Entrypoints ////////////////////

function kickoffKnowledgeIndexV1() {
  var lock = _tryLock_('KI', 280);
  try {
    var startHere = _getFolderByPath_(KI.PATHS.START_HERE);
    var root = _getFolderByPath_(KI.PATHS.ROOT);

    var rows = [];
    var chunks = [];
    _walkFolder_(root, 'Your Friend Logan', rows, chunks);

    if (KI.DO_WRITE) {
      _emitCsv_(startHere, 'Knowledge__INDEX__LATEST.csv', rows,
        'id,title,mimeType,modifiedDate,fileSize,path,webViewLink,exportable');
      _emitCsv_(startHere, 'Knowledge__CHUNKS__LATEST.csv', chunks,
        'id,chunkIndex,start,end,length,path');
    }
    Logger.log(JSON.stringify({
      indexLatest: 'Knowledge__INDEX__LATEST.csv',
      chunksLatest: 'Knowledge__CHUNKS__LATEST.csv',
      countIndex: rows.length,
      countChunks: chunks.length
    }, null, 2));
  } finally {
    lock.releaseLock();
  }
}

function showStatusKnowledge() {
  var startHere = _getFolderByPath_(KI.PATHS.START_HERE);
  function _probe(name) {
    var it = startHere.getFilesByName(name);
    if (!it.hasNext()) return null;
    var f = it.next();
    return { name: name, bytes: f.getSize(), updated: f.getLastUpdated(), url: f.getUrl() };
  }
  var out = {
    indexLatest: _probe('Knowledge__INDEX__LATEST.csv'),
    chunksLatest: _probe('Knowledge__CHUNKS__LATEST.csv')
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
