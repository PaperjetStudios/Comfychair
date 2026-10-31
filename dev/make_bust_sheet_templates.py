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
