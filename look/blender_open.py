"""Blender (with its window) opening one model for a look: `blender --python look/blender_open.py -- <file>`. Started by
sceneasset.blender_open. The default objects go, the model comes in and the view frames it. The model's own file isn't
touched: nothing here saves, so what is done in Blender stays there until it is saved somewhere by hand."""
import os
import sys

import bpy

path = sys.argv[sys.argv.index("--") + 1]
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
ext = os.path.splitext(path)[1].lower()
if ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=path)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=path)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=path)
print(f"opened {len(bpy.data.objects)} objects", flush=True)


def frame():
    """The view on the whole model, once the window is up (it isn't while this script runs)."""
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next(r for r in area.regions if r.type == "WINDOW")
                with bpy.context.temp_override(window=win, area=area, region=region):
                    bpy.ops.view3d.view_all()
                return None
    return None


if not bpy.app.background:
    bpy.app.timers.register(frame, first_interval=0.5)
