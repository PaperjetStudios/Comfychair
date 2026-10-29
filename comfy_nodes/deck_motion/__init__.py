"""ComfyChair: save generated or captured human motion where ComfyChair finds it.

Deck Save Motion takes HY-Motion's motion data (ComfyUI-HY-Motion1) and writes the first 22 joints per frame
as a JSON file in the output folder, listed as a node output, so ComfyChair's 3D tab can put it on a figure
(app/motion.py reads it). HY-Motion's own Save NPZ writes a file but doesn't list it as an output.
Deck Save Body Motion does the same for a person in a video, from SAM 3D Body's pose data (video mocap).
"""
import json
import os

import folder_paths

HY_FPS = 30.0


class DeckSaveMotion:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"motion_data": ("HYMOTION_DATA",), "filename_prefix": ("STRING", {"default": "deck_motion"})}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def save(self, motion_data, filename_prefix):
        k3d = motion_data.output_dict["keypoints3d"]
        out_dir = folder_paths.get_output_directory()
        files = []
        for i in range(motion_data.batch_size):
            pts = k3d[i]
            pts = pts.cpu().numpy() if hasattr(pts, "cpu") else pts
            data = {"fps": HY_FPS, "frames": [[[round(float(c), 4) for c in p] for p in f[:22]] for f in pts],
                    "text": str(getattr(motion_data, "text", "") or ""), "source": "hy-motion"}
            folder, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
            fname = f"{name}_{counter:05}_.json"
            with open(os.path.join(folder, fname), "w") as f:
                json.dump(data, f, separators=(",", ":"))
            files.append({"filename": fname, "subfolder": sub, "type": "output"})
        return {"ui": {"files": files}}


# SAM 3D Body (ComfyUI's SAM3DBody_* nodes) gives MHR70 keypoints per person per frame, in camera space once its
# translation is added (x right, y down, z away). The 3D tab wants the SMPL / HumanML3D 22 joints, y up: the
# limbs map straight across; the spine, collars and head that MHR70 doesn't have are placed between them.
MHR = {"nose": 0, "lear": 3, "rear": 4, "lsho": 5, "rsho": 6, "lelb": 7, "relb": 8, "lhip": 9, "rhip": 10,
       "lknee": 11, "rknee": 12, "lank": 13, "rank": 14, "ltoe": 15, "lsmall": 16, "rtoe": 18, "rsmall": 19,
       "rwri": 41, "lwri": 62, "neck": 69}


def mhr_to_smpl22(k):
    """(70, 3) MHR70 keypoints -> (22, 3) SMPL joints (pelvis, L/R hip, spine1, L/R knee, spine2, L/R ankle, spine3,
    L/R foot, neck, L/R collar, head, L/R shoulder, L/R elbow, L/R wrist)."""
    import numpy as np
    p = {n: np.asarray(k[i], dtype=np.float64) for n, i in MHR.items()}
    pelvis = (p["lhip"] + p["rhip"]) / 2
    up = p["neck"] - pelvis
    spine = lambda t: pelvis + up * t
    lcol, rcol = p["neck"] + (p["lsho"] - p["neck"]) * 0.45, p["neck"] + (p["rsho"] - p["neck"]) * 0.45
    head = (p["lear"] + p["rear"]) / 2
    return np.stack([pelvis, p["lhip"], p["rhip"], spine(0.25), p["lknee"], p["rknee"], spine(0.5), p["lank"], p["rank"],
                     spine(0.78), (p["ltoe"] + p["lsmall"]) / 2, (p["rtoe"] + p["rsmall"]) / 2, p["neck"], lcol, rcol,
                     head, p["lsho"], p["rsho"], p["lelb"], p["relb"], p["lwri"], p["rwri"]])


# MHR70 hands (sam_3d_body metadata): right 21–41 and left 42–62. Each finger is tip, first, second, third
# joint, then the wrist. third is the knuckle. Stored knuckle → tip, wrist first, so the figure's three
# joints are the angles between consecutive segments.
_FINGERS = ("thumb", "index", "middle", "ring", "pinky")
_LOGGED = False


def _np_of(x):
    import numpy as np
    if x is None:
        return None
    return np.asarray(x.cpu() if hasattr(x, "cpu") else x, dtype=np.float64)


def hands_of(k):
    """(70, 3) keypoints → {l, r: 21 points}, wrist then four points per finger, knuckle to tip. None if the hands aren't there."""
    import numpy as np
    k = np.asarray(k, dtype=np.float64).reshape(-1, 3)
    if k.shape[0] < 63:
        return None
    def block(start):
        pts = [k[start + 20]]
        for f in range(5):
            b = start + f * 4
            pts.extend([k[b + 3], k[b + 2], k[b + 1], k[b]])
        return pts
    return {"r": block(21), "l": block(42)}


def _fill_series(rows):
    """None gaps filled from the nearest frames, held at the ends. rows are arrays of the same shape."""
    import numpy as np
    known = [i for i, f in enumerate(rows) if f is not None]
    if not known:
        return None
    out = list(rows)
    for i in range(len(out)):
        if out[i] is None:
            a = max((k for k in known if k < i), default=None)
            b = min((k for k in known if k > i), default=None)
            out[i] = out[b] if a is None else out[a] if b is None else out[a] + (out[b] - out[a]) * ((i - a) / (b - a))
    return out


def body_pack(pose_data, person=0):
    """One person: 22 joints, and when the 70 keypoints are there the hands, the face (nose, eyes, ears) and cam_t.
    All of them are keypoints + camera translation, then y and z flipped (camera space has y down and z away)."""
    import numpy as np
    global _LOGGED
    flip = np.array([1.0, -1.0, -1.0])
    joints, hands_l, hands_r, face, cam, rots = [], [], [], [], [], []
    saw_hands = False
    for people in pose_data.get("frames") or []:
        d = people[person] if person < len(people) else None
        k = _np_of(d.get("pred_keypoints_3d")) if d else None
        if k is None:
            joints.append(None); hands_l.append(None); hands_r.append(None); face.append(None); cam.append(None); rots.append(None)
            continue
        if not _LOGGED:
            _LOGGED = True
            print("Deck Save Body Motion keys:", sorted(d.keys()))
        k = k.reshape(-1, 3)
        t = _np_of(d.get("pred_cam_t"))
        t = np.zeros(3) if t is None else t.reshape(-1)[:3]
        joints.append((mhr_to_smpl22(k) + t) * flip)
        h = hands_of(k)
        if h:
            saw_hands = True
            hands_l.append(np.stack([(p + t) * flip for p in h["l"]]))
            hands_r.append(np.stack([(p + t) * flip for p in h["r"]]))
            face.append(np.stack([(k[i] + t) * flip for i in (0, 1, 2, 3, 4)]))
        else:
            hands_l.append(None); hands_r.append(None); face.append(None)
        cam.append(t * flip)
        r = _np_of(d.get("pred_global_rots"))
        rots.append(r.reshape(-1) if r is not None and r.size <= 2000 else None)
    known = [i for i, f in enumerate(joints) if f is not None]
    if not known:
        raise ValueError("Deck Save Body Motion: no person found in any frame (try a clip where the whole body shows)")
    joints = _fill_series(joints)
    pack = {"frames": joints, "cam_t": _fill_series(cam)}
    if saw_hands:
        pack["hands"] = {"l": _fill_series(hands_l), "r": _fill_series(hands_r)}
        pack["face"] = _fill_series(face)
    got = _fill_series(rots)
    if got is not None:
        pack["rots"] = got
    return pack


def body_frames(pose_data, person=0):
    """[(22, 3) y-up joints per frame] for one person. Frames where the person isn't found are filled."""
    return body_pack(pose_data, person)["frames"]


def body_focal(pose_data, person=0):
    """The focal length (pixels) SAM 3D Body used for this person, the median over the frames, or None."""
    import numpy as np
    vals = []
    for people in pose_data.get("frames") or []:
        f = people[person].get("focal_length") if person < len(people) else None
        if f is not None:
            v = np.asarray(f.cpu() if hasattr(f, "cpu") else f, dtype=np.float64).reshape(-1)
            if v.size and np.isfinite(v[0]) and v[0] > 0:
                vals.append(float(v[0]))
    return float(np.median(vals)) if vals else None


class DeckSaveBodyMotion:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mhr_pose_data": ("MHR_POSE_DATA",),
                             "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0,
                                               "tooltip": "The clip's frame rate as it was loaded"}),
                             "person": ("INT", {"default": 0, "min": 0, "max": 16, "tooltip": "Which person, when there are several"}),
                             "filename_prefix": ("STRING", {"default": "deck_mocap"})}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def save(self, mhr_pose_data, fps, person, filename_prefix):
        pack = body_pack(mhr_pose_data, int(person))
        rnd = lambda a: [[[round(float(c), 4) for c in p] for p in f] for f in a]
        data = {"fps": float(fps), "frames": rnd(pack["frames"]), "source": "sam3d-body",
                "cam_t": [[round(float(c), 4) for c in t] for t in pack["cam_t"]]}
        if pack.get("hands"):
            data["hands"] = {s: rnd(pack["hands"][s]) for s in ("l", "r")}
            data["face"] = rnd(pack["face"])
        if pack.get("rots") is not None:
            data["rots"] = [[round(float(c), 4) for c in r] for r in pack["rots"]]
        focal = body_focal(mhr_pose_data, int(person))
        if focal:   # (the lens SAM 3D Body assumed, in pixels: the 3D tab's mocap camera uses it)
            data["focal"] = round(focal, 2)
        out_dir = folder_paths.get_output_directory()
        folder, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        fname = f"{name}_{counter:05}_.json"
        with open(os.path.join(folder, fname), "w") as f:
            json.dump(data, f, separators=(",", ":"))
        return {"ui": {"files": [{"filename": fname, "subfolder": sub, "type": "output"}]}}


NODE_CLASS_MAPPINGS = {"DeckSaveMotion": DeckSaveMotion, "DeckSaveBodyMotion": DeckSaveBodyMotion}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckSaveMotion": "Deck Save Motion", "DeckSaveBodyMotion": "Deck Save Body Motion"}
