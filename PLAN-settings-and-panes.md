# Settings tabs, sidebar order, basics pane: to pick up later

Done 2026-10-30 (Generate tab only, uncommitted):
- `layout.js` `basicsPane()`: size, length, seed and similar leave the sidebar for a pane over the viewer, opened by a button beside ⛶.
- `generate.js` `isBasic()` picks them; `sizeField` folds the ratio buttons into one ⊞ button for Match image / Custom.
- `generate.js` `GROUP_ORDER`: one sidebar group order for every template (prompt, inputs, LoRAs, control, size/length, other, model, Advanced).

## To do

1. Global Settings gets tabs (it is one list now, `prefs.js` `DEFAULTS` + its rows).
2. Sidebar order setting: drag to reorder the group kinds in `GROUP_ORDER`, kept in `PREFS` (per device or in the synced store?). Reset to default. Show a list of the group names the templates actually use, so a stray name can be given a place.
3. Basics pane setting: choose which fields count as basics (`isBasic`, `BASIC_INPUT`, `BASIC_LABEL`), and whether the pane starts open.
4. Bring the basics pane to the other panels: Editor, Video, VFX, Inpaint, Story. Their settings are hand-built, not template fields, so each needs its own list of what goes in the pane. Same rule: out of the sidebar, not copied.
5. Check the pane in a browser: phone width, full screen with the panel pulled out, touch.
6. A hand-check of group names across all templates against `GROUP_ORDER` (first match wins; "Control picture" is an input, "Control" is a strength).
