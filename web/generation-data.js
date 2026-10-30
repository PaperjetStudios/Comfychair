import { api, toast } from './ui.js';
import { S, emitServer } from './core.js';

export async function fetchHistory(more = false) {
  const items = [...S.history.values()].filter((g) => g.project_id === S.project);
  const before = more && items.length ? Math.min(...items.map((g) => g.id)) : null;
  try {
    const rows = await api(`/api/generations?limit=60${S.project != null ? `&project_id=${S.project}` : ''}${before ? `&before=${before}` : ''}`);
    for (const g of rows) S.history.set(g.id, g);
    S.historyDone = rows.length < 60;
  } catch (e) { toast(e.message, true); }
  emitServer({ type: 'history_loaded' });
}
