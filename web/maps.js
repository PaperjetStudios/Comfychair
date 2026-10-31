// The templates that draw a control map (depth, edges, scribble, pose) from a clip or a picture. The VFX tab's Quick
// effects and the Image tab's Image tools both read them here, so the two doors can't drift apart.
export const MAPS = {
  depth: { video: 'deck-depth-video', still: 'deck-depth-image' },
  canny: { video: 'deck-canny-video', still: 'deck-canny-image' },
  scribble: { video: 'deck-scribble-video', still: 'deck-scribble-image' },
  pose: { video: 'deck-pose-video', sd: 'deck-pose-sdpose', still: 'deck-pose-image', stillSd: 'deck-pose-sdpose-image' },
};
