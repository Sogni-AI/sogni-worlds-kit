# Putting a world online

A finished world is a folder of plain files: the player (`index.html` and its
scripts), `world.json`, and the stills, films and sounds it plays. There is no
server, database or account behind it, so any host that serves files can run
it — including free ones.

## 1. Build and check it

```bash
node world build            # finishes every approved take and writes build/world.json
node world play             # plays it on http://localhost:5173/ — go through every path
```

`build` lists anything not in the world yet (films with no approved take,
narration not spoken yet) and any place you cannot leave or cannot reach. A
visitor only ever sees what you approved.

## 2. Export

```bash
node world export           # → dist/<world>/
node world export --out ~/Sites/my-trip
```

The folder is emptied and rebuilt each time, so point `--out` at a folder of
its own (inside this repository, exports go under `dist/`, which git ignores).

What is inside, and how big it gets:

| Path | What |
| --- | --- |
| `index.html`, `player-assets/` | The player |
| `world.json` | The world: places, things to click, films, narration, music |
| `stills/` | One photograph per place |
| `films/<film>.mp4` | Each film at full size (2K class: 2304 × 1536 for 3:2 photos) |
| `films/<film>-720.mp4` | The same film at exactly half size, for phones and slow connections |
| `films/<film>-rewind*.mp4` | Crossings played backwards, for Back |
| `audio/` | Narration and music |

A 2K film is roughly 0.5–1.5 MB per second. The Long White Cloud (22 places,
40 crossings) comes to about 2.4 GB with its half-size copies and rewinds; a
five-place starter world is a few hundred MB. The export prints the total.

## 3. Put it online

Any one of these works. Each gives you a public link to share.

**Netlify** — the quickest: drag the exported folder onto
[app.netlify.com/drop](https://app.netlify.com/drop), or

```bash
npx netlify-cli deploy --dir dist/<world> --prod
```

**Vercel**

```bash
npx vercel dist/<world> --prod
```

**Cloudflare Pages** (generous bandwidth, good for film-heavy worlds)

```bash
npx wrangler pages deploy dist/<world>
```

**GitHub Pages** — free, but it refuses single files over 100 MB and sites
over about 1 GB; `export` warns you. Put the folder's contents on a
`gh-pages` branch of a repository and turn on Pages for that branch:

```bash
cd dist/<world>
git init -b gh-pages && git add -A && git commit -m "My world"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin gh-pages
```

(The export includes an empty `.nojekyll` so GitHub serves every file as is.)

**Your own server or S3** — upload the folder. Serve `.mp4` as `video/mp4` and
allow byte-range requests (every mainstream server and CDN does), so films can
seek and start quickly.

## Checking the live copy

Open the link on a phone and on a computer, with sound on:

- the first place loads and its photograph comes alive;
- every thing to click has its outline and label, and plays its film;
- a crossing lands exactly on the next place's photograph (no jump);
- Back plays the way you came;
- narration and music play after the first tap, and the music steps back under films.

## Updating a world

Approve new takes, `node world build`, `node world export`, and upload the
folder again. Unchanged films are not re-encoded. Film file names stay the same
when a film is replaced, so give your host's cache a moment, or purge it.

## Privacy

Everything in the exported folder is public once it is online: your
photographs, any narration in your own voice, and `world.json`. Photos and
recordings of other people need their permission. Nothing else from your
computer — not your API key, not `world.yaml`, not your review verdicts — is
copied into the export.
