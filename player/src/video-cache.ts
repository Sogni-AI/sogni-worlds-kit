// Hold a film in memory before it is asked for, so a click plays local bytes.
//
// A streamed film only has the bytes around wherever it was last playing, and
// nothing at all until it is asked for. A place fetches what the visitor may
// click next, likeliest first and one at a time, into a small ring of whole
// clips; the element is then handed a blob: URL and starts at once. Fetching
// stops while a film plays, so the connection is the film's alone.

const MAX_CACHED = 6;

type Entry = { blobUrl: string; lastAccess: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, { promise: Promise<string | null>; controller: AbortController }>();
/** A clip that could not be fetched is not retried on every arrival. */
const failed = new Set<string>();

function evict() {
  if (cache.size <= MAX_CACHED) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [url, entry] of oldest.slice(0, cache.size - MAX_CACHED)) {
    URL.revokeObjectURL(entry.blobUrl);
    cache.delete(url);
  }
}

/** The local copy of a clip when one has been fetched, otherwise the clip's own address. */
export function localOrRemote(url: string): string {
  const entry = cache.get(url);
  if (!entry) return url;
  entry.lastAccess = Date.now();
  return entry.blobUrl;
}

/** Fetch a clip into memory, or join the fetch already running for it. */
function preload(url: string): Promise<string | null> {
  if (cache.has(url)) return Promise.resolve(localOrRemote(url));
  if (failed.has(url)) return Promise.resolve(null);
  const running = inFlight.get(url);
  if (running) return running.promise;
  const controller = new AbortController();
  const promise = fetch(url, { credentials: 'omit', signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error(`The film returned ${response.status}`);
      const blobUrl = URL.createObjectURL(await response.blob());
      cache.set(url, { blobUrl, lastAccess: Date.now() });
      evict();
      return blobUrl;
    })
    .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) failed.add(url); return null; })
    .finally(() => { inFlight.delete(url); });
  inFlight.set(url, { promise, controller });
  return promise;
}

/**
 * Fetch clips before their turn, likeliest first and one at a time. Returns a
 * stop: clips not yet started are dropped and the one in flight is abandoned,
 * so a film that starts playing has the connection to itself.
 */
export function fetchAhead(urls: readonly string[]): () => void {
  let live = true;
  let current: string | null = null;
  void (async () => {
    for (const url of urls) {
      if (!live) return;
      current = url;
      await preload(url);
      current = null;
    }
  })();
  return () => {
    live = false;
    if (current) inFlight.get(current)?.controller.abort();
  };
}
