// What a drag from outside the app carries. A file window gives Files; a web browser may give only links to the picture
// (Firefox always, Chrome sometimes), which are fetched here into a File so a drop works the same from either.

export const dropKind = (f) => f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : f.type.startsWith('image/') ? 'image'
  : /\.(mov|mp4|m4v|mkv|webm|avi)$/i.test(f.name) ? 'video' : /\.(wav|mp3|m4a|flac|ogg|oga|aac|opus)$/i.test(f.name) ? 'audio'
  : /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name) ? 'image' : null;

// A drag that began on this page is not a drop from outside (a native drag of one of the app's own pictures).
let inside = false;
if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', () => { inside = true; }, true);
  document.addEventListener('dragend', () => { inside = false; }, true);
}

// During the drag only the types can be read. Dragged text has neither of these, so it still drops into a text box.
export function draggingPicture(dt) {
  const types = [...(dt?.types || [])];
  return !inside && ['Files', 'text/uri-list', 'text/x-moz-url'].some((t) => types.includes(t));
}

// Where the picture may be, likeliest first: the <img> dragged (a linked picture's uri-list is the page it links to),
// then the links, then an inline data: picture (often only a lazy-loading placeholder).
export function pictureLinks({ html = '', uris = '', moz = '' } = {}) {
  const web = [], inline = [];
  const add = (raw) => {
    const u = (raw || '').trim().replace(/&amp;|&#38;/g, '&');
    const to = /^https?:\/\//i.test(u) ? web : /^data:image\//i.test(u) ? inline : null;
    if (to && !to.includes(u)) to.push(u);
  };
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  uris.split(/\r?\n/).filter((l) => !l.startsWith('#')).forEach(add);
  add(moz.split(/\r?\n/)[0]);
  return [...web, ...inline];
}

// A File's name from where it came from, with an extension for its type.
export function pictureName(url, type = '') {
  let base = '';
  if (/^https?:/i.test(url)) {
    try { base = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* a link that won't parse: the default name */ }
  }
  const ext = (type.split('/')[1] || 'png').split('+')[0].replace('jpeg', 'jpg');
  base = base.replace(/[^\w.-]+/g, '_') || 'dropped';
  return /\.\w{2,5}$/.test(base) ? base : `${base}.${ext}`;
}

async function fetchPicture(url) {
  // the app's own (another ComfyChair tab) and data: the browser can read; another site's only the server can (CORS)
  const here = url.startsWith('data:') || new URL(url).origin === location.origin;
  const r = here ? await fetch(url)
    : await fetch('/api/fetch-picture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!r.ok) {
    const why = await r.json().then((d) => d.detail).catch(() => null);
    throw new Error(why || 'Couldn\'t get that picture');
  }
  const b = await r.blob();
  return new File([b], pictureName(url, b.type), { type: b.type });
}

// The files of a drop: [File]. Call it during the drop event (the browser empties dataTransfer straight after).
// Throws if there were only links and none gave a picture.
export function droppedFiles(dt) {
  const files = [...(dt?.files || [])];
  const links = pictureLinks({ html: dt?.getData('text/html'), uris: dt?.getData('text/uri-list'), moz: dt?.getData('text/x-moz-url') });
  return (async () => {
    if (files.some(dropKind)) return files;
    let failed = null;
    for (const u of links) {
      try { return [await fetchPicture(u)]; } catch (e) { failed = e; }
    }
    if (failed) throw failed;
    return files;
  })();
}
