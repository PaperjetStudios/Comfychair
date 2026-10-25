// Starter scenes for the 3D tab: rooms and places blocked in from the shapes a scene already has
// (box, ball, cylinder, wall, a person for scale, the room), so a shot can start from somewhere.
// Each entry's build() returns a fresh scene (scene-data's defaultScene with its own layers and camera).
import { defaultScene, newObject, newRoom } from './scene-data.js';

// a shape: S(type, name, x, z, [width, height, depth], { y, rx, ry, rz }); they all sit on y = 0 unless y says
const S = (type, name, x, z, size, o = {}) => ({ type, name, x, z, size, ...o });

function make({ room, cam, items, person = [0, 0, 0] }) {
  const sc = defaultScene();
  sc.room = room ? { ...newRoom(), ...room } : null;
  sc.camera.base = { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, ...cam };
  sc.objects = items.map(({ type, name, x, z, size: [sx, sy, sz], y = 0, rx = 0, ry = 0, rz = 0 }) => {
    const o = newObject(type, { x, y, z, rx, ry, rz, sx, sy, sz }, []);
    o.name = name;
    return o;
  });
  if (person) {  // a person for scale (delete it if it's in the way)
    const p = newObject('person', { x: person[0], y: person[2], z: person[1] }, []);
    p.name = 'Person 1'; sc.objects.push(p);
  }
  return sc;
}

// a curve from the floor up to a wall, as short tilted slabs (an infinity cove)
function cove(zWall, r, width, n = 6) {
  const out = [], pt = (deg) => [r * (1 - Math.cos(deg * Math.PI / 180)), zWall + r - r * Math.sin(deg * Math.PI / 180)];
  for (let i = 0; i < n; i++) {
    const [y0, z0] = pt(90 * i / n), [y1, z1] = pt(90 * (i + 1) / n);
    const tilt = Math.atan2(y1 - y0, z0 - z1) * 180 / Math.PI;  // from the floor, 90 = upright
    out.push(S('wall', `Cove ${i + 1}`, 0, z0, [width, Math.hypot(y1 - y0, z1 - z0) * 1.03, 0.06], { y: y0, rx: tilt - 90 }));
  }
  return out;
}

// pseudo-random but always the same (so a template is the same every time)
const rnd = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function trees() {
  const r = rnd(7), out = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + r() * 0.3, d = 6 + r() * 7, s = 0.8 + r() * 0.8;
    const x = +(Math.cos(a) * d).toFixed(2), z = +(Math.sin(a) * d - 2).toFixed(2);
    out.push(S('cylinder', `Trunk ${i + 1}`, x, z, [0.35 * s, 3.2 * s, 0.35 * s]),
      S('ball', `Canopy ${i + 1}`, x, z, [2.4 * s, 3.4 * s, 2.4 * s], { y: 2.2 * s }));
  }
  return out;
}

export const LIBRARY = [
  { id: 'studio', name: 'Empty studio', hint: 'Infinity cove: a floor that curves up into the back wall',
    build: () => make({ room: { w: 16, d: 14, h: 4, walls: false, ceiling: false }, cam: { pz: 6, py: 1.5, ty: 1.2 },
      items: [...cove(-5, 1.5, 16), S('wall', 'Back wall', 0, -5, [16, 3.5, 0.06], { y: 1.5 })] }) },
  { id: 'street', name: 'Street corner', hint: 'A street meeting a cross street, buildings, a lamp post and a car',
    build: () => make({ room: { w: 40, d: 44, h: 3, walls: false, ceiling: false }, cam: { py: 1.6, pz: 11, ty: 1.8, tz: -6 }, person: [-3, 4, 0.15],
      items: [
        S('box', 'Building left', -10, 2, [8, 10, 12]), S('box', 'Building right', 10, 0, [8, 7, 16]),
        S('box', 'Building far left', -10, -19, [8, 12, 12]), S('box', 'Building far right', 10, -19, [8, 9, 12]),
        S('box', 'Building end', 0, -29, [30, 14, 6]),
        S('box', 'Sidewalk left', -5, 2, [2, 0.15, 12]), S('box', 'Sidewalk right', 5, 0, [2, 0.15, 16]),
        S('box', 'Sidewalk far left', -5, -19, [2, 0.15, 12]), S('box', 'Sidewalk far right', 5, -19, [2, 0.15, 12]),
        S('cylinder', 'Lamp post', -4.5, 5, [0.14, 4.6, 0.14], { y: 0.15 }), S('ball', 'Lamp', -4.5, 5, [0.5, 0.35, 0.5], { y: 4.6 }),
        S('box', 'Car body', 1.8, -1, [1.8, 0.7, 4.3], { y: 0.3 }), S('box', 'Car cabin', 1.8, -1.2, [1.6, 0.6, 2.2], { y: 1 }),
        // wheels lie along x: the right pair turns +90 so it reaches back into the body, the left pair -90
        ...[[2.78, -2.4, 90], [2.78, 0.4, 90], [0.82, -2.4, -90], [0.82, 0.4, -90]].map(([x, z, rz], i) =>
          S('cylinder', `Wheel ${i + 1}`, x, z, [0.7, 0.2, 0.7], { y: 0.35, rz })),
        S('box', 'Mailbox', -4.6, 0, [0.4, 1, 0.5], { y: 0.15 }), S('box', 'Bin', 4.6, 3, [0.5, 0.9, 0.5], { y: 0.15 })] }) },
  { id: 'living', name: 'Living room', hint: 'Sofa, coffee table, rug, TV, bookshelf and a lamp in a 6 x 5 m room',
    build: () => make({ room: { w: 6, d: 5, h: 2.8, walls: true, ceiling: true }, cam: { px: 2.4, py: 1.5, pz: 2.2, tx: -0.5, ty: 0.9, tz: -1.2, fov: 50 }, person: [-1.4, 0.4, 0],
      items: [
        S('box', 'Rug', -0.5, -0.9, [2.8, 0.02, 1.9]),
        S('box', 'Sofa seat', -0.5, -1.9, [2.1, 0.42, 0.9]), S('box', 'Sofa back', -0.5, -2.3, [2.1, 0.5, 0.18], { y: 0.42 }),
        S('box', 'Sofa arm left', -1.62, -1.9, [0.18, 0.28, 0.9], { y: 0.42 }), S('box', 'Sofa arm right', 0.62, -1.9, [0.18, 0.28, 0.9], { y: 0.42 }),
        S('box', 'Coffee table', -0.5, -0.6, [1.1, 0.4, 0.6]),
        S('box', 'TV stand', -2.75, 0, [1.6, 0.5, 0.4], { ry: 90 }), S('box', 'TV', -2.8, 0, [1.1, 0.65, 0.05], { y: 0.5, ry: 90 }),
        S('box', 'Bookshelf', 2.5, -2.3, [1.1, 2, 0.32]),
        S('box', 'Armchair seat', 1.7, -0.9, [0.8, 0.42, 0.8]), S('box', 'Armchair back', 1.7, -1.25, [0.8, 0.45, 0.15], { y: 0.42 }),
        S('cylinder', 'Lamp pole', -2.1, -2, [0.05, 1.5, 0.05]), S('cylinder', 'Lamp shade', -2.1, -2, [0.4, 0.3, 0.4], { y: 1.3 }),
        S('box', 'Door', -2.95, -1.9, [0.9, 2.05, 0.05], { ry: 90 })] }) },
  { id: 'forest', name: 'Forest clearing', hint: 'Open ground ringed with trees, rocks and a fallen log',
    build: () => make({ room: { w: 40, d: 40, h: 3, walls: false, ceiling: false }, cam: { py: 1.5, pz: 6, ty: 1.7, tz: -5 },
      items: [...trees(),
        S('ball', 'Rock 1', 2.6, -2.5, [1.1, 0.6, 0.9]), S('ball', 'Rock 2', 3.4, -1.6, [0.6, 0.4, 0.5]), S('ball', 'Rock 3', -3.2, -3.5, [1.4, 0.8, 1.1]),
        S('cylinder', 'Log', -1.5, -3, [0.4, 3, 0.4], { y: 0.4, rz: 90 }), S('cylinder', 'Stump', 1.2, -4, [0.55, 0.45, 0.55])] }) },
  { id: 'stage', name: 'Stage', hint: 'A raised stage with back curtain, wings, lighting truss and speakers, seen from the audience',
    build: () => make({ room: { w: 18, d: 16, h: 6, walls: false, ceiling: false }, cam: { py: 1.6, pz: 9, ty: 2.2, tz: -2 }, person: [0, 0, 0.9],
      items: [
        S('box', 'Stage', 0, -2, [10, 0.9, 6]), S('wall', 'Back curtain', 0, -5.1, [11, 5, 0.15], { y: 0.9 }),
        S('wall', 'Wing left', -5.6, -3, [4, 5, 0.15], { y: 0.9, ry: 90 }), S('wall', 'Wing right', 5.6, -3, [4, 5, 0.15], { y: 0.9, ry: 90 }),
        S('cylinder', 'Truss post left', -5.2, 0, [0.16, 5.6, 0.16], { y: 0.9 }), S('cylinder', 'Truss post right', 5.2, 0, [0.16, 5.6, 0.16], { y: 0.9 }),
        S('cylinder', 'Truss', 5.2, 0, [0.14, 10.4, 0.14], { y: 6.3, rz: 90 }),
        ...[-3, 0, 3].map((x, i) => S('cylinder', `Light ${i + 1}`, x, 0, [0.35, 0.45, 0.35], { y: 5.8 })),
        S('box', 'Speaker left', -4.4, -0.2, [0.8, 1.2, 0.6], { y: 0.9 }), S('box', 'Speaker right', 4.4, -0.2, [0.8, 1.2, 0.6], { y: 0.9 }),
        S('cylinder', 'Mic stand', 0.6, 1.2, [0.03, 1.5, 0.03], { y: 0.9 }), S('box', 'Drum riser', -2.4, -3.6, [2.6, 0.3, 2], { y: 0.9 })] }) },
];
