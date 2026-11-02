// One-time import of the Kit's own small receipt folders, never account history.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export function legacyAttempts(dir) {
  const found = new Map();
  const visit = (value, kind, source) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.projectId === 'string' && value.projectId) {
      const currency = value.billing?.tokenType ?? 'spark';
      const cost = value.costActual;
      const charge = value.paymentModel === 'subscription' ? { usd: '0', tokens: '0', currency }
        : cost?.costInUSD != null && cost?.costInToken != null ? { usd: cost.costInUSD, tokens: cost.costInToken, currency } : null;
      found.set(value.projectId, { ...found.get(value.projectId), provider: 'sogni', projectId: value.projectId, kind, model: value.modelId ?? value.model ?? 'unknown', status: value.status ?? 'unknown', currency,
        ...(charge ? { charge } : {}), ...(value.quote?.usd != null ? { estimate: { usd: String(value.quote.usd) } } : {}) });
    } else if (value.status === 'submitting') {
      // No project ID means receipt recovery is needed, not that it was free.
      const id = `legacy:${createHash('sha256').update(source).digest('hex')}`;
      found.set(id, { id, provider: 'sogni', kind, model: value.model ?? 'unknown', status: 'submission-uncertain', currency: value.billing?.tokenType ?? 'spark' });
    }
    for (const [key, child] of Object.entries(value)) {
      if (['plateProject', 'matteProject', 'meshProject'].includes(key) && typeof child === 'string') {
        visit({ projectId: child }, key === 'meshProject' ? '3d' : 'image', source);
      } else if (child && typeof child === 'object') visit(child, kind, source);
    }
  };
  const walk = (folder, kind) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file, kind);
      else if (entry.isFile() && /\.json(?:\.[^.]+\.old)?$/.test(entry.name)) {
        let json;
        try { json = JSON.parse(readFileSync(file, 'utf8')); }
        catch { throw new Error(`Cannot import the damaged receipt ${relative(dir, file)}`); }
        visit(json, kind, relative(dir, file));
      }
    }
  };
  for (const [folder, kind] of [['renders', 'video'], ['audio', 'audio'], ['voices', 'audio'], ['figures', '3d'], ['selections', 'image'], ['reveals', 'image'], ['agent/paint', 'image']]) walk(join(dir, folder), kind);
  return [...found.values()];
}
