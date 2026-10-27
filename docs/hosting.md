# Putting a world online

A finished world is a folder of plain files: the player (`index.html` and its
scripts), `world.json`, and the stills, films and sounds it plays. There is no
server, database or account behind it, so any host that serves files can run
it — including free ones.

## Contents

- Build and export — prepare the static folder and public URL.
- What a world serves — check media formats before adding files.
- Put it online — choose and configure a static host.
- Checking the live copy — verify the published experience.
- Submit to the Sogni community gallery — read when the creator wants a listing.
- Preview loop — choose an existing loop or prepare a teaser.
- Video share cards — defaults, embedded players and stale social cards.
- Updating a world — rebuild and update an existing listing.
- Privacy — read before publishing personal media.

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
node world export --url https://<name>.pages.dev/   # the link it will be played at
```

The folder is emptied and rebuilt each time, so point `--out` at a folder of
its own (inside this repository, exports go under `dist/`, which git ignores).

Its `index.html` carries the world's link-preview tags: the title, the subtitle
and the cover (the social card) that social sites and chat apps show for a
link. They need the cover as a full link, so pass `--url` with the public link
visitors will play it at once you know it (on Cloudflare Pages that is
`https://<name>.pages.dev/`, known before you deploy). Without `--url` the cover
link is relative to the page: `node world submit` still reads it.
When its opening loop qualifies as a preview and `--url` is supplied, the export
also generates an X video card and `preview/index.html`, a lightweight embedded
player. Otherwise X uses the image card. See [Video share cards](#video-share-cards).

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
| `preview/index.html` | Video-only share player, when a loop qualifies and `--url` is supplied |

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

### Cloudflare Pages

The recommended free option. It runs on Cloudflare's free plan and serves
byte-range requests, so films seek and start fast.

1. Make a free Cloudflare account at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you
   don't have one.
2. Sign in once from this computer. It opens your browser: click **Allow**. The
   sign-in gives up after 2 minutes, so start it when you are at the browser.

   ```bash
   npx wrangler@4.129.0 login
   ```

3. Create the project once, with `main` as its live branch. Pick a name for it
   (the world's id works):

   ```bash
   npx wrangler@4.129.0 pages project create <name> --production-branch main
   ```

4. Deploy the export to that live branch. Name the branch every time: wrangler
   otherwise takes it from the git branch you are on, and a deploy from any
   other branch is only a preview, not what `https://<name>.pages.dev` shows.

   ```bash
   npx wrangler@4.129.0 pages deploy dist/<world> --project-name <name> --branch main
   ```

Your world is then at `https://<name>.pages.dev`; use that link to share and
to submit it. (The link wrangler prints with an extra prefix in front is that
one deployment's.) You can attach your own domain later in the Cloudflare
dashboard.

Limits: every file must be 25 MiB or less, and a site holds up to 20,000
files. `export` warns you about any file over 25 MiB. **A world with a file
over 25 MiB will be refused by Pages.** Host it on another service below, such
as Netlify, or put the large films on Cloudflare R2. The account owner must
enable R2 in the Cloudflare dashboard first. It is on the free plan, but it may
ask for a card on file.

### Other hosts

**Netlify**: drag the exported folder onto
[app.netlify.com/drop](https://app.netlify.com/drop), or

```bash
npx netlify-cli@27.12.0 deploy --dir dist/<world> --prod
```

**Vercel**

```bash
npx vercel@63.1.2 dist/<world> --prod
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
node world submit <world> --url https://your-world.example/
```

Open the printed link (or add `--open`). It fills in the title, description,
cover (the world's `social.jpg`) and scene/path counts from your built world.
Sign in with your Sogni account, check the details and sharing permissions, then
submit. You can also fill in the form at
[worlds.sogni.ai/submit-world](https://worlds.sogni.ai/submit-world) directly.
The listing is credited to your Sogni username (as `@username`), from the
account you sign in with; there is no name to type. Older scripts that still
pass `--creator` keep working: `submit` says it is no longer needed and leaves
it out.

Submitting is free. Your world must play publicly without a login. Sogni reviews
the complete experience before listing it in the public community gallery.
Approval and feedback appear in [My worlds](https://worlds.sogni.ai/?view=mine),
where you can update or withdraw the listing. The gallery credits your Sogni
username and links visitors to your hosted world; your files stay with your host. Your Sogni API key
is never sent with the submission. To have the gallery play a teaser of your
world, add a [preview loop](#preview-loop).

## Preview loop

A preview loop is optional. Sogni Worlds plays it on your world's card in
Community worlds and on its listing page, and in the homepage banner when Sogni
features your world. What it takes:

- a short MP4 that loops: 4 to 15 seconds;
- H.264 with fast start;
- optionally, a stereo AAC soundtrack: Sogni Worlds plays it only when a visitor
  points at your card (or taps its speaker button) with sound on;
- 16:9, at 1280 × 720 or 1920 × 1080;
- under 10 MB;
- hosted next to the world, on HTTPS;
- a clean loop: either its first and last frames match, or it cuts between
  shots at the loop point, like a teaser montage.

A Kit world may have one already. When the opening place's living photograph
(its phone copy first) is 16:9 (the Kit's 16:9 canvas, 1344 × 768, counts), runs
4 to 15 seconds, is under 10 MB and ends on its first frame, `export` names it
as the page's `og:video` and `submit` lists it as the preview. Nothing is made
for it, and `export` says which film it named or why none qualifies. That film
keeps its AAC sound track, which plays only when a visitor points at your card
(or taps its speaker button) with sound on.

Otherwise, make one. The opening place's living photograph is a good start: it
begins and ends on the same still, so it loops without a jump. Copy it with the
Kit's own film profile, cropped to 16:9 at 1280 × 720 and without its sound
(to keep the sound, replace `-an` with `-c:a aac -ac 2 -b:a 160k`), next to the
world you host:

```bash
ffmpeg -i dist/<world>/films/<opening place>-loop.mp4 \
  -vf "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=1280:720:flags=lanczos" -an \
  -c:v libx264 -profile:v high -preset slow -crf 23 -maxrate 4500000 -bufsize 9000000 -g 48 \
  -pix_fmt yuv420p -movflags +faststart dist/<world>/preview.mp4
```

`export` empties its folder each time, so make the preview after your last
export, or keep it elsewhere and copy it in. Watch it loop a few times before
you submit it. Then pass its public link
(`--preview` always wins over the film `export` named):

```bash
node world submit <world> --url https://your-world.example/ \
  --preview https://your-world.example/preview.mp4
```

For a world built outside the Kit, `submit` uses the page's `og:video` when you
don't pass `--preview` (its `og:video:secure_url`, `og:video:url` or `og:video`,
the first HTTPS one; one typed `video/mp4` first when the page lists several).
The preview link must be a public HTTPS link, like the cover.

## Video share cards

Prefer video when an approved preview represents the experience well at card
size. Watch it first: avoid blurry footage, unwanted spoilers, broken loop
seams or sound that does not match its picture. Reuse approved media; this
default does not authorize a new render or publication. A JPEG image card is
the right choice when no suitable preview is available.

`export --url <public HTTPS directory>` uses the opening loop that passes the
checks above for both `og:video` and `twitter:card=player`. It writes
`twitter:player` pointing at `preview/`, width and height from the actual film,
and `twitter:player:stream` / `twitter:player:stream:content_type` pointing at
the same MP4. `og:image` and `twitter:image` remain for the poster and clients
without video support. With no qualifying loop or public URL, it keeps
`summary_large_image`. Re-exporting removes any obsolete preview player.

The iframe is just a responsive video with controls, inline playback, looping
and muted autoplay. It loads no game code. Its HTML, MP4 and poster must load
over public HTTPS without sign-in; the host must allow X to embed the iframe.
Keep the audio in the file and let the viewer turn sound on. For a custom
teaser or export, generate this same metadata and player; `submit --preview`
changes the gallery listing only, not the page's share tags.

After hosting, check the initial HTML as `Twitterbot/1.0`, the player in an
iframe, playback and controls, then use X's
[Card Validator](https://cards-dev.x.com/validator). Report metadata validation
and actual post playback separately; never post on someone's behalf just to
test a card. Do not expose private media for link crawlers.

If an image card was already shared, X may retain it after the site is updated.
For the next post, serve the same experience at a fresh share path with its own
`og:url` and canonical identity, rather than redirecting to the cached address.
For Kit exports, export the world into that path with `--url` set to the fresh
public address. Keep the original link working and updated. A host cache purge
does not clear X's cache, and a query parameter is not a guaranteed refresh.

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
