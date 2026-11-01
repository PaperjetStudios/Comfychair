// What made a 3D run, by name (no DOM: tests/made_by.test.mjs). The templates' ids say little; this is the name people know them by.
const MADE_BY = {
  'deck-3d-object': 'Pixal3D',
  'deck-3d-object-multi': 'Pixal3D multi-view',
  'deck-3d-object-trellis': 'TRELLIS.2',
  'deck-3d-object-splat': 'Idol',
  '3d photo': 'MoGe',
  'deck-autorig-human': 'Make It Animatable',
  'deck-autorig-any': 'UniRig',
};
export const madeBy = (g) => MADE_BY[g?.template] || null;
