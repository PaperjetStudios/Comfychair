// The empty payload of each engine's saved document, in one light module (no three.js, no DOM) so table-frames.js can make a
// frame's blank document without loading the engines. video.js, sound.js and scene-data.js use these as their TabSet
// adapters' empty(), so a frame's blank document and a tab's blank document are the same thing.

// (ui.js store.get, without pulling ui.js in: this module loads in node, too)
const saved = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };

export const videoTracks = () => [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }];
export const soundTracks = () => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];

export const emptyVideo = () => ({ tracks: videoTracks(), items: [], size: null, fps: 0, range: null });
// format: the mix's file format (sound.js passes the one on show)
export const emptySound = (format = saved('deck.sound.format', 'm4a')) =>
  ({ tracks: soundTracks(), items: [], out: { name: '', format, gain: 1, normalize: false }, gens: [] });
// a new scene starts empty, as Clear all leaves it (no layers, no room; the camera stays)
export function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, blur: 2, room: null,
    camera: { id: 'cam0', name: 'Camera', base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, roll: 0 }, chans: {}, ease: 'smooth' }, cams: [],
    cuts: [], shotText: {}, tcStart: '01:00:00:00', renderShots: 'take',
    objects: [],
  };
}
export const emptyScene = defaultScene;

// the empty payload for a frame kind that is not an image (null: none)
export function emptyPayload(kind) {
  if (kind === 'video') return emptyVideo();
  if (kind === 'sound') return emptySound();
  if (kind === 'scene') return emptyScene();
  return null;
}
