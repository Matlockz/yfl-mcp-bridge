/**
 * YFL Drive Bridge — GAS side v7.1 (JSON-only web app)
 * Advanced Drive Service: enabled as "Drive" (v2). Query semantics use v2 ("title", not "name").
 * Routes:
 *   action=health
 *   action=tools/list
 *   action=tools/call&name=drive.search|drive.list|drive.get|drive.export&...
 */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = (p.action || '').trim();

    if (!action) return respond_({ ok: true, routes: ['health','tools/list','tools/call'] });

    // Require token for all actions except health
    if (action !== 'health' && !authOk_(p.token)) return respond_({ ok: false, error: 'unauthorized' });

    if (action === 'health')     return respond_({ ok: true, ts: new Date().toISOString() });
    if (action === 'tools/list') return respond_({ ok: true, tools: TOOL_LIST_() });
    if (action === 'tools/call') return handleToolCall_(p);

    return respond_({ ok: false, error: 'unknown action', action });
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

// ----- helpers -----
function respond_(obj)    { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function authOk_(token)   { return token && token === PropertiesService.getScriptProperties().getProperty('SHARED_KEY'); }
function TOOL_LIST_()     { return [
  { name: 'drive.list',   description: 'List files in a folder by ID' },
  { name: 'drive.search', description: 'Drive v2 query (e.g., title contains, trashed=false)' },
  { name: 'drive.get',    description: 'File metadata by id' },
  { name: 'drive.export', description: 'Export Google Docs/Sheets/Slides' }
];}

function handleToolCall_(p) {
  const name = (p.name || '').trim();
  const args = Object.assign({}, p); // carry through query parameters
  delete args.action; delete args.token; delete args.name;

  try {
    if (name === 'drive.search') return respond_(driveSearch_(args));
    if (name === 'drive.list')   return respond_(driveList_(args));
    if (name === 'drive.get')    return respond_(driveGet_(args));
    if (name === 'drive.export') return respond_(driveExport_(args));
    return respond_({ ok: false, error: 'unknown tool', name });
  } catch (err) {
    return respond_({ ok: false, error: String(err && err.message || err) });
  }
}

// ----- tools (Drive Advanced Service v2) -----
function driveSearch_(args) {
  const q = args.q || "title contains 'Transcripts__INDEX__LATEST' and trashed=false";
  const pageToken = args.pageToken || null;
  const maxResults = Number(args.maxResults || 50);
  const out = Drive.Files.list({ q: q, pageToken: pageToken, maxResults: maxResults });
  return { ok: true, items: out.items || [], nextPageToken: out.nextPageToken || null };
}

function driveList_(args) {
  const folderId = args.folderId;
  if (!folderId) return { ok: false, error: 'folderId required' };
  const q = "'" + folderId + "' in parents and trashed=false";
  const out = Drive.Files.list({ q: q, maxResults: Number(args.maxResults || 50), pageToken: args.pageToken || null });
  return { ok: true, items: out.items || [], nextPageToken: out.nextPageToken || null };
}

function driveGet_(args) {
  const id = args.id;
  if (!id) return { ok: false, error: 'id required' };
  const file = Drive.Files.get(id);
  return { ok: true, file: file };
}

function driveExport_(args) {
  const id = args.id;
  if (!id) return { ok: false, error: 'id required' };
  // Choose MIME by hinted type
  const mime = args.mime || 'text/plain';
  // In Apps Script Advanced Drive, export may return HTTPResponse — normalize to Blob
  const resp = Drive.Files.export(id, mime);
  const blob = (resp && resp.getBlob) ? resp.getBlob() : resp; // if it already is a Blob
  const bytes = blob.getBytes();
  // Note: Drive v3 export is limited to ~10 MB per file; plan chunking if needed. 
  // (limit is on API side; for big docs consider partial exports or alternate formats)
  return { ok: true, id: id, mime: mime, size: bytes.length, dataBase64: Utilities.base64Encode(bytes) };
}
