import { aimFree } from './scene-view.js';
import { cameraPanel, editOut, editPanel, renderProps } from './scene-ui.js';
import { shotProps } from './scene-shots.js';
import { hint, section } from './ui.js';
import { registerMode } from './scene-modes.js';

// The three modes (see scene-modes.js for what a mode can say)
export function registerBuiltins() {
  registerMode({ key: 'edit', label: 'Edit scene', icon: '✎', hint: 'Edit scene mode: place and arrange scene contents', panel: editPanel, out: editOut,
    frustum: true });   // (the director view draws the camera here too)

  registerMode({ key: 'camera', label: 'Camera', icon: '🎥', hint: 'Camera directing / animation mode: block out and animate the camera through the scene',
    panel: cameraPanel, out: () => [shotProps(), renderProps()], select: false, lanes: 'camera', frustum: true });

  // an empty stage; the modelling tools plug in with addModeSection('create', build)
  registerMode({ key: 'create', label: 'Create object', icon: '⬢', hint: 'Create object mode: basic modelling for simple shapes only',
    panel: () => section('Create object', null, hint('Modelling tools come next: simple shapes (boxes, balls, cylinders and the like) built up here, then placed in the scene.')),
    select: false, stage: 'empty', view: 'free', lanes: 'none', enter: () => aimFree([2.6, 1.9, 3.4], [0, 0.5, 0]) });
}
