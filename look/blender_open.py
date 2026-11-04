"""Blender (with its window) opening one model for a look: `blender --python look/blender_open.py -- <file>`. Started by
sceneasset.blender_open. The default objects go, the model comes in and the view frames it. The model's own file isn't
touched: nothing here saves, so what is done in Blender stays there until it is saved somewhere by hand.
A splat (.ply, .spz) is followed by `flip` when its layer is Upside down. Blender's Z is up. A .ply comes in with its axes as
they are, so Y (or -Y with flip) is stood up by a quarter turn on X. A .spz comes in already Z-up, so only flip turns it, by a half
turn. Blender can't export a splat, so it can't come back from there."""
import math
import os
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1:]
path = args[0]
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
ext = os.path.splitext(path)[1].lower()
if ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=path)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=path)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=path)
elif ext == ".ply":
    bpy.ops.wm.ply_import(filepath=path)
elif ext == ".spz":   # (no operator for it: a Geometry Nodes node reads it, from the file each time it evaluates)
    tree = bpy.data.node_groups.new(os.path.basename(path), "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    reader, out = tree.nodes.new("GeometryNodeImportSPZ"), tree.nodes.new("NodeGroupOutput")
    reader.inputs["Path"].default_value = path
    tree.links.new(reader.outputs[0], out.inputs[0])
    ob = bpy.data.objects.new(os.path.splitext(os.path.basename(path))[0], bpy.data.meshes.new("splat"))
    bpy.context.collection.objects.link(ob)
    ob.modifiers.new("Splat", "NODES").node_group = tree
if ext in (".ply", ".spz"):
    flip = "flip" in args[1:]
    for ob in bpy.data.objects:
        ob.rotation_euler[0] = math.radians((-90 if flip else 90) if ext == ".ply" else (180 if flip else 0))
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
