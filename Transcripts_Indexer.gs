/** ***************************************************************
 *  YFL — Transcripts Indexer (v2-safe; all‑media‑safe) — 2025‑10‑19
 *  • Finds transcripts (2.x → 3.x) via DriveApp (v2 semantics)
 *  • Builds INDEX (metadata) + CHUNKS (6,000 / overlap 400, newline‑aware)
 *  • DO_WRITE = true to emit CSVs + LATEST beacons
 *******************************************************************/

var TI = {
  DO_WRITE: true,
  PATHS: {
    CANON_DIR: 'Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here',
    LIB_DIR:   'Your Friend Logan/ChatGPT_Assets/Knowledge/Transcripts'
  },
  QUERY: 'title contains "ChatGPT_Transcript_Quill_LoganBot_" and trashed = false',
  PAGE_SIZE: 200,
  CHUNK: { SIZE: 6000, OVERLAP: 400 },
  // v2 fields (avoid v3/v2 name drift)
  GET_FIELDS: 'id,title,mimeType,modifiedDate,fileSize,alternateLink,exportLinks'
};

/** Entry point — full index + chunk build. */
function kickoffTranscriptsIndexV2() {
  var start = Date.now();
  var metas = findTranscripts_();
  var indexCsv = buildIndexCsv_(metas);
  var chunksCsv = buildChunksCsv_(metas);

  var indexName  = 'Transcripts__INDEX__'  + today_() + '.csv';
  var chunksName = 'Transcripts__CHUNKS__' + today_() + '.csv';

  if (TI.DO_WRITE) {
    var canon = getOrMakeFolderByPath_(TI.PATHS.CANON_DIR);
    var lib   = getOrMakeFolderByPath_(TI.PATHS.LIB_DIR);

    // Write dated snapshots (library)
    writeOrReplace_(lib,   indexName,  indexCsv, MimeType.CSV);
    writeOrReplace_(lib,   chunksName, chunksCsv, MimeType.CSV);

    // Update LATEST beacons in START_HERE
    writeOrReplace_(canon, 'Transcripts__INDEX__LATEST.csv',  indexCsv,  MimeType.CSV);
    writeOrReplace_(canon, 'Transcripts__CHUNKS__LATEST.csv', chunksCsv, MimeType.CSV);
  }

  return _json_({
    ok: true,
    data: {
      hits: metas.length,
      indexRows: (indexCsv.match(/\n/g) || []).length + 1,
      chunksRows: (chunksCsv.match(/\n/g) || []).length + 1,
      indexName, chunksName,
      ms: Date.now() - start
    }
  });
}

/** Show sizes/links for both LATEST beacons. */
function showStatus() {
  var canon = getOrMakeFolderByPath_(TI.PATHS.CANON_DIR);
  var msg = { indexLatest: null, chunksLatest: null };

  var idx = canon.getFilesByName('Transcripts__INDEX__LATEST.csv');
  if (idx.hasNext()) {
    var f = idx.next();
    msg.indexLatest = {
      name: f.getName(), bytes: f.getSize(),
      updated: f.getLastUpdated().toISOString(), url: f.getUrl()
    };
  }
  var chk = canon.getFilesByName('Transcripts__CHUNKS__LATEST.csv');
  if (chk.hasNext()) {
    var g = chk.next();
    msg.chunksLatest = {
      name: g.getName(), bytes: g.getSize(),
      updated: g.getLastUpdated().toISOString(), url: g.getUrl()
    };
  }
  Logger.log(JSON.stringify(msg));
  return msg;
}

/* ---------- Core ---------- */

function findTranscripts_() {
  var items = [];
  // DriveApp.searchFiles uses Drive v2 query semantics; quote literals properly.
  // Example: 'title contains "untitled"' and 'trashed = false'. :contentReference[oaicite:4]{index=4}
  var it = DriveApp.searchFiles(TI.QUERY);
  while (it.hasNext()) {
    var file = it.next();
    var meta = _withBackoff_(function () {
      return Drive.Files.get(file.getId(), { fields: TI.GET_FIELDS });
    });
    items.push(meta);
    if (items.length >= TI.PAGE_SIZE) break;
  }
  return items;
}

function buildIndexCsv_(metas) {
  var header = ['id','title','mimeType','modifiedDate','fileSize','alternateLink'];
  var out = [header.join(',')];
  metas.forEach(function (m) {
    out.push([m.id, _csv(m.title), m.mimeType, m.modifiedDate, m.fileSize || '', _csv(m.alternateLink || '')].join(','));
  });
  return out.join('\n');
}

function buildChunksCsv_(metas) {
  var out = [];
  metas.forEach(function (m) {
    var text = exportText_(m); // { id, title, body }
    var chunks = chunkText_(text.body, TI.CHUNK.SIZE, TI.CHUNK.OVERLAP);
    var pos = 0;
    for (var i = 0; i < chunks.length; i++) {
      var t = chunks[i];
      var start = pos, end = start + t.length;
      out.push([m.id, _csv(m.title), (i + 1), start, end, t.length, _csv(t)].join(','));
      pos = end;
    }
  });
  return 'id,title,chunkIndex,start,end,length,text\n' + out.join('\n');
}

/* ---------- Export helpers ---------- */

function exportText_(meta) {
  var id = meta.id, mt = String(meta.mimeType || '');
  // Google Docs -> text/plain
  if (mt === 'application/vnd.google-apps.document') {
    try {
      // Advanced Drive v2 – include the 3rd param so Apps Script actually returns the data
      var resp = Drive.Files.export(id, 'text/plain', { alt: 'media' });
      var txt  = resp.getBlob().getDataAsString('UTF-8');
      return { id:id, title:meta.title, body: txt };
    } catch (e) {
      // Fallback via DocumentApp (needs Docs scope)
      var txt2 = DocumentApp.openById(id).getBody().getText();
      return { id:id, title:meta.title, body: txt2 };
    }
  }
  // Google Sheets -> CSV (first sheet)
  if (mt === 'application/vnd.google-apps.spreadsheet') {
    var resp2 = Drive.Files.export(id, 'text/csv', { alt: 'media' });
    var csv   = resp2.getBlob().getDataAsString('UTF-8');
    return { id:id, title:meta.title, body: csv };
  }
  // Non‑Google files -> read blob as text
  var body = DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8');
  return { id:id, title:meta.title, body: body };
}

/** Newline‑aware chunker (prefers ending on a newline within last 500 chars). */
function chunkText_(s, maxLen, overlap) {
  if (!s) return [];
  var out = [], step = Math.max(1, maxLen - overlap);
  for (var pos = 0; pos < s.length; ) {
    var end = Math.min(s.length, pos + maxLen);
    var slice = s.substring(pos, end);
    var nl = slice.lastIndexOf('\n');
    if (nl > -1 && (slice.length - nl) <= 500) { slice = slice.substring(0, nl + 1); end = pos + slice.length; }
    out.push(slice);
    if (end === s.length) break;
    pos = Math.min(s.length, pos + step);
  }
  return out;
}

/* ---------- Drive helpers ---------- */

function getOrMakeFolderByPath_(absPath) {
  var parts = String(absPath || '').replace(/^\/+|\/+$/g, '').split('/');
  var cur = DriveApp.getRootFolder();
  for (var i = 0; i < parts.length; i++) {
    var it = cur.getFoldersByName(parts[i]);
    cur = it.hasNext() ? it.next() : cur.createFolder(parts[i]);
  }
  return cur;
}

function writeOrReplace_(folder, name, body, mime) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);
  folder.createFile(name, body, mime);
}

/* ---------- Utilities ---------- */

function today_() {
  var d = new Date(), y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + dd;
}

function _withBackoff_(fn) {
  var waits = [0, 300, 800, 1500, 3000];
  for (var i = 0; i < waits.length; i++) {
    try { if (waits[i]) Utilities.sleep(waits[i]); return fn(); }
    catch (e) {
      var msg = String(e), retriable = /rate|quota|429|500|502|503|504|backend/i.test(msg);
      if (!retriable || i === waits.length - 1) throw e;
    }
  }
}

function _csv(s) { if (s == null) return ''; var t = String(s).replace(/"/g, '""'); return '"' + t + '"'; }

function _json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
