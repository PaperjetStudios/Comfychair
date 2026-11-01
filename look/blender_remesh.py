"""Clean up a model in Blender (run headless by app/sceneasset.py):

    blender -b -P look/blender_remesh.py -- IN.glb OUT.glb MODE AMOUNT [TEXTURE_SIZE]

MODE   quads     Quadriflow: clean quad topology with about AMOUNT faces (falls back to voxel when the shape won't take it)
       voxel     Voxel remesh, AMOUNT = the voxel size as a share of the model's height (0.01 = 1%)
       decimate  keep AMOUNT of the faces (0.3 = 30%), same UVs
       subdivide AMOUNT levels of subdivision (1-3), same UVs
The two that rebuild the surface (quads, voxel) make new UVs and bake the old texture's colour onto them (TEXTURE_SIZE px).
Prints one JSON line last: {"faces": n} or {"error": "..."}.
"""
import json
import sys

import bpy

src, dst, mode, amount = sys.argv[sys.argv.index("--") + 1:][:4]
tex_size = int((sys.argv[sys.argv.index("--") + 1:] + ["2048"])[4])
amount = float(amount)


def finish(**kw):
    print(json.dumps(kw))
    sys.stdout.flush()
    sys.exit(0 if "error" not in kw else 1)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    finish(error="No mesh in that file")
for o in bpy.context.scene.objects:
    o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = meshes[0]
for o in meshes:   # (a glTF is often several parts under a parent: bake the transforms in, then join into one mesh)
    o.parent = None
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
height = max(obj.dimensions) or 1.0
rebuild = mode in ("quads", "voxel")
textured = any(m for m in obj.data.materials if m and m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes))

if rebuild:
    hi = obj
    lo = hi.copy(); lo.data = hi.data.copy(); lo.name = "clean"
    bpy.context.collection.objects.link(lo)
    lo.data.materials.clear()
    for o in bpy.context.scene.objects:
        o.select_set(False)
    lo.select_set(True); bpy.context.view_layer.objects.active = lo
    done = False
    if mode == "quads":
        # Quadriflow answers {'CANCELLED'} (it doesn't raise) when it can't take a mesh: a first try on the model as it is, then
        # on a fine voxel skin (a scan-like shape with holes and loose bits), before settling for the voxel mesh itself
        def quads():
            try:
                r = bpy.ops.object.quadriflow_remesh(target_faces=int(amount), use_mesh_symmetry=False, use_preserve_sharp=False,
                                                     use_preserve_boundary=True, smooth_normals=True, mode="FACES")
            except RuntimeError:
                return False
            return r == {"FINISHED"} and len(lo.data.polygons) > 0
        bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.remove_doubles(threshold=1e-6); bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        done = quads()
        if not done:
            lo.data.remesh_voxel_size = height * 0.004
            bpy.ops.object.voxel_remesh()
            done = quads()
    if mode == "voxel" or not done:
        lo.data.remesh_voxel_size = height * (amount if mode == "voxel" else 0.006)
        bpy.ops.object.voxel_remesh()
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    # big calm islands (a high angle limit: a person is mostly gentle curves), scaled alike, turned to pack tightly
    bpy.ops.uv.smart_project(angle_limit=1.4, island_margin=0.004, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    if textured:
        mat = bpy.data.materials.new("baked"); mat.use_nodes = True
        lo.data.materials.append(mat)
        img = bpy.data.images.new("baked", tex_size, tex_size)
        node = mat.node_tree.nodes.new("ShaderNodeTexImage"); node.image = img
        mat.node_tree.nodes.active = node
        sc = bpy.context.scene
        sc.render.engine = "CYCLES"; sc.cycles.samples = 1; sc.cycles.device = "CPU"
        sc.render.bake.use_pass_direct = False; sc.render.bake.use_pass_indirect = False
        sc.render.bake.use_selected_to_active = True
        sc.render.bake.cage_extrusion = height * 0.02
        sc.render.bake.max_ray_distance = height * 0.1
        sc.render.bake.margin = 4
        hi.select_set(True); lo.select_set(True); bpy.context.view_layer.objects.active = lo
        # the bake reads the colour a Diffuse pass shows, and Diffuse is darkened by Metallic (these models carry a metal
        # map from the ORM texture): take the metal out of the source for the bake so the base colour comes through whole
        for m in hi.data.materials:
            if not (m and m.use_nodes):
                continue
            for n in m.node_tree.nodes:
                if n.type != "BSDF_PRINCIPLED":
                    continue
                for name in ("Metallic", "Transmission Weight", "Coat Weight", "Sheen Weight"):
                    sock = n.inputs.get(name)
                    if sock is None:
                        continue
                    for l in list(sock.links):
                        m.node_tree.links.remove(l)
                    sock.default_value = 0.0
        bpy.ops.object.bake(type="DIFFUSE")
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        mat.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    bpy.data.objects.remove(hi, do_unlink=True)
    obj = lo
elif mode == "decimate":
    m = obj.modifiers.new("d", "DECIMATE"); m.ratio = max(0.01, min(1.0, amount))
    bpy.ops.object.modifier_apply(modifier=m.name)
elif mode == "subdivide":
    m = obj.modifiers.new("s", "SUBSURF"); m.levels = int(max(1, min(3, amount))); m.render_levels = m.levels
    bpy.ops.object.modifier_apply(modifier=m.name)
else:
    finish(error=f"Unknown mode {mode}")

bpy.ops.object.shade_smooth()
for o in bpy.context.scene.objects:
    o.select_set(o is obj)
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=True, export_apply=True)
finish(faces=len(obj.data.polygons))
