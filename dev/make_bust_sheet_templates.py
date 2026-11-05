"""Shorter character sheets, made from deck-h3-charsheet: a bust (head to mid-waist) instead of the full figure.

Run: .venv/bin/python dev/make_bust_sheet_templates.py
Frames are seconds x 24; H3 eases into the orbit, so the orbit frames are the full sheet's scaled by orbit length.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'templates'
BASE = json.loads((ROOT / 'deck-h3-charsheet.json').read_text())

BUST = ("A bust shot of <Subject 1> from the top of the head to the mid-waist, standing still in a relaxed neutral pose, "
        "in the centre of an empty light-grey photo studio with a seamless backdrop and flat, even softbox lighting. ")
ORBIT = ("The camera orbits around <Subject 1> at a slow, constant speed and makes exactly one full 360-degree turn: "
         "front, side, back, the other side, and front again, always framing head to mid-waist. "
         "<Subject 1> stays still and keeps the same pose.")
TAIL = ("\nNo subtitles, on-screen text or watermarks.\noverall_soundscape: quiet studio room tone. No voice.\n"
        "non_diegetic_music: N/A")


def prompt(cuts):
    p = f"<Subject 1> is the character shown in <Picture 1>.\n[Shot 1] {BUST}{ORBIT}"
    for i, (t, text) in enumerate(cuts, 2):
        p += f"\n[Shot {i}] At 00:{t:06.3f}, the camera cuts to {text}"
    return p + TAIL


def make(name, seconds, orbit_frames, cuts, per_row, label):
    d = json.loads(json.dumps(BASE))
    d['7']['inputs']['prompt'] = prompt(cuts)
    d['7']['inputs']['length'] = round(seconds * 24) + 6
    d['40']['inputs']['indexes'] = ','.join(str(f) for f in orbit_frames)
    d['41']['inputs']['max_images_per_row'] = per_row
    for k in ('15', '42'):
        key = 'filename_prefix'
        d[k]['inputs'][key] = f'comfydeck/{label}'
    (ROOT / f'{name}.json').write_text(json.dumps(d, indent=1) + '\n')


FACE = "a close-up of <Subject 1>'s face"
# 6 images, 8 s: orbit 5 s (front, side, back, other side) + face front + face three-quarter
make('deck-h3-charsheet-bust', 8, [3, 45, 80, 100, 138, 174], [
    (5.0, f"{FACE} from the front, neutral expression, looking into the lens."),
    (6.5, f"{FACE} from a three-quarter angle."),
], 3, 'h3bust')
# 4 images, 5.5 s: orbit 4 s (front, side, back) + face front
make('deck-h3-charsheet-bust4', 5.5, [3, 36, 64, 114], [
    (4.0, f"{FACE} from the front, neutral expression, looking into the lens."),
], 4, 'h3bust4')

# The body sheet, for detail where a model needs it: the full sheet's whole orbit of the full figure, then the body instead of the
# face. 8 images, 13 s: orbit 6 s + chest, back, legs and feet, 1.75 s each, a frame from the middle of each
WHOLE = BASE['7']['inputs']['prompt'].split('\n[Shot 2]')[0]   # (its first lines: who it is, and the orbit)
d = json.loads(json.dumps(BASE))
d['7']['inputs']['prompt'] = (
    f"{WHOLE}"
    "\n[Shot 2] At 00:06.000, the camera cuts to a close-up of <Subject 1>'s chest from the front, from the collarbones to the waist, showing every detail of the outfit."
    "\n[Shot 3] At 00:07.750, the camera cuts to a close-up of <Subject 1>'s back from directly behind, from the shoulders to the waist, showing every detail of the outfit."
    "\n[Shot 4] At 00:09.500, the camera cuts to a shot of <Subject 1>'s legs from the front, from the hips to the ankles, both legs fully in frame."
    "\n[Shot 5] At 00:11.250, the camera cuts to a low close-up of <Subject 1>'s feet and footwear from the front, both feet fully in frame, on the floor."
    f"{TAIL}")
d['7']['inputs']['length'] = 13 * 24 + 6
d['40']['inputs']['indexes'] = '4,54,96,120,165,207,249,291'
d['41']['inputs']['max_images_per_row'] = 4
for k in ('15', '42'):
    d[k]['inputs']['filename_prefix'] = 'comfydeck/h3body'
(ROOT / 'deck-h3-charsheet-body.json').write_text(json.dumps(d, indent=1) + '\n')

# The head sheet, for a face from every side: an orbit of the head at eye level (a picture every 45 degrees), then the face from above and
# from below. 12 images, 12 s, square: orbit 6 s (the full sheet's frames, with the 45-degree ones between them) + 4 cuts of 1.5 s
d = json.loads(json.dumps(BASE))
d['7']['inputs']['prompt'] = (
    "<Subject 1> is the person shown in <Picture 1>."
    "\n[Shot 1] A close-up of <Subject 1>'s head and shoulders at eye level, head upright and level, neutral expression, mouth closed, "
    "eyes looking straight ahead, in the centre of an empty light-grey photo studio with a seamless backdrop and flat, even softbox "
    "lighting with no hard shadows. The camera orbits around <Subject 1>'s head at a slow, constant speed and makes exactly one full "
    "360-degree turn: front, three-quarter view, side profile, back of the head, the other side profile, the other three-quarter view, "
    "and front again, always at eye level and framing the whole head from the top of the hair to the shoulders. <Subject 1> stays "
    "perfectly still, does not turn the head and does not follow the camera with the eyes."
    "\n[Shot 2] At 00:06.000, the camera cuts to a high-angle close-up of <Subject 1>'s face from the front: the camera is above the "
    "head and looks down at the forehead, nose and face. <Subject 1> keeps the head level and looks straight ahead."
    "\n[Shot 3] At 00:07.500, the camera cuts to a low-angle close-up of <Subject 1>'s face from the front: the camera is below the "
    "chin and looks up at the jaw, nostrils and face. <Subject 1> keeps the head level and looks straight ahead."
    "\n[Shot 4] At 00:09.000, the camera cuts to a high-angle close-up of <Subject 1>'s face from a three-quarter angle, the camera "
    "above the head looking down."
    "\n[Shot 5] At 00:10.500, the camera cuts to a low-angle close-up of <Subject 1>'s face from the other three-quarter angle, the "
    "camera below the chin looking up."
    f"{TAIL}")
d['7']['inputs']['width'] = d['7']['inputs']['height'] = 640
d['7']['inputs']['length'] = 12 * 24 + 6
d['40']['inputs']['indexes'] = '4,30,54,70,96,108,120,142,162,198,234,270'   # (checked on one run: the orbit ends near 315 degrees at the cut)
d['41']['inputs']['max_images_per_row'] = 4
for k in ('15', '42'):
    d[k]['inputs']['filename_prefix'] = 'comfydeck/h3head'
(ROOT / 'deck-h3-charsheet-head.json').write_text(json.dumps(d, indent=1) + '\n')
