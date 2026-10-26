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
visitor only ever sees what you approved. It also checks every file the world
serves against the web formats below and writes no `world.json` if one is off.

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
| `stills/<place>.webp` | One picture per place (and `stills/reveals/` for close looks), WebP |
| `films/<film>.mp4` | Each film at full size (2K class: 2304 × 1536 for 3:2 photos) |
| `films/<film>-720.mp4` | The same film at exactly half size, for phones and slow connections |
| `films/<film>-rewind*.mp4` | Crossings played backwards, for Back |
| `audio/` | Narration and music |
| `figures/` | 3D figures (GLB) and their icons (WebP) |
| `social.jpg` | The card a link to the world shows: its opening picture, 1200 × 630 |

The bitrate cap holds a 2K film to about 1.5 MB per second (12 Mbps) and its
half-size copy to about 0.56 MB per second (4.5 Mbps); calm films come in well
under. The export prints the total.

## What a world serves

Everything in the export is in the formats the web plays best, the same ones
Sogni's own worlds use. `build` makes them and `export` refuses to copy anything
else, naming each file and what is wrong with it.

| What | Format |
| --- | --- |
| Stills and close looks | WebP, quality 84 with sharp YUV, at their own pixel size (never enlarged), no camera metadata |
| Films | H.264 MP4, yuv420p, CRF 23 with the bitrate capped by the short edge (up to 768 px: 4.5 Mbps; up to 1080 px: 8 Mbps; above, 2K: 12 Mbps; buffer twice the cap), a keyframe every 2 s, the index at the front (fast start) |
| The phone copy | Every film again at exactly half size (`src720`), under its own cap |
| Social card | JPEG, 1200 × 630 (crawlers do not all read WebP) |
| Icons | WebP, or PNG of 512 px or less. PNG is for icons only |
| Sound | MP3 or AAC (a place's own WAV or AIFF track is encoded as MP3) |

A film is checked by whether any stretch of it carries more than its cap
allows (the cap for that long plus the buffer), so a visitor on a link at the
cap never waits once it is playing. A short, busy film may average a little
over its cap: that is the buffer, spent as the cap allows. The PNGs the
pipeline keeps (painted places, outlines, masks, a figure's plates) stay in
your world's folder; they are never served. Look at what you ship at full size,
on faces, writing, edges and skies, not only at the file size.

Editing `world.json` by hand or adding a file yourself? Convert it first:

```bash
# a still: WebP at its own size, metadata stripped
node -e "require('sharp')('in.png').webp({quality:84,smartSubsample:true,effort:6}).toFile('out.webp')"
# a 2K film (use 4500000/9000000 for 768 px or less, 8000000/16000000 up to 1080 px; -g is 2 s of frames)
ffmpeg -i in.mp4 -c:v libx264 -preset slow -crf 23 -maxrate 12000000 -bufsize 24000000 -g 48 \
  -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k out.mp4
```

Never make a 2K copy of a film that was not delivered at 2K: an enlarged film is
bigger and no sharper.

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

## Submit to the Sogni community gallery

After checking the live copy, run:

```bash
node world submit <world> --url https://your-world.example/ --creator "Your name"
```

Open the printed link (or add `--open`). It fills in the title, description,
cover (the world's `social.jpg`), creator credit and scene/path counts from your
built world.
Sign in with your Sogni account, check the details and sharing permissions, then
submit. You can also fill in the form at
[worlds.sogni.ai/submit-world](https://worlds.sogni.ai/submit-world) directly.

Submitting is free. Your world must play publicly without a login. Sogni reviews
the complete experience before listing it in the public community gallery.
Approval and feedback appear in [My worlds](https://worlds.sogni.ai/?view=mine),
where you can update or withdraw the listing. The gallery credits you and links
visitors to your hosted world; your files stay with your host. Your Sogni API key
is never sent with the submission.

## Updating a world

If it is listed in Sogni's public gallery, withdraw the listing from
[My worlds](https://worlds.sogni.ai/?view=mine) before changing the content.
After uploading the update, open that listing and submit the new version for
review. A listing under review is not shown in the gallery.

Approve new takes, `node world build`, `node world export`, and upload the
folder again. Unchanged films are not re-encoded. Film file names stay the same
when a film is replaced, so give your host's cache a moment, or purge it.

A world first built with an earlier version of the kit is encoded again on its
next build, and its stills change from `.jpg` to `.webp`. If its gallery listing
points its cover at an old `stills/….jpg`, change the cover link to the new
`social.jpg` when you submit the update (`node world submit` prints it).

## Privacy

Everything in the exported folder is public once it is online: your
photographs, any narration in your own voice, and `world.json`. Photos and
recordings of other people need their permission. Nothing else from your
computer — not your API key, not `world.yaml`, not your review verdicts — is
copied into the export.
