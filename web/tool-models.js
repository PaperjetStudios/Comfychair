// Several models ticked for one image tool, with no DOM (tests/tool_models.test.mjs): each ticked model is one run of it.
//   ticked(list, single)     the saved list, or for settings kept before there were lists, the one model they chose
//   chosen(list, single, can)  the ticked models that can run here, in the order they are offered
//   toggled(list, k)         the list with k ticked or unticked
export const ticked = (list, single) => (Array.isArray(list) ? list : single != null ? [single] : []);
export const chosen = (list, single, can = () => true) => ticked(list, single).filter(can);
export const toggled = (list, k) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
