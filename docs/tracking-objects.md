# Track a moving clickable object

> **November 2026:** new tracks clean their moving outlines for clicking (stray
> flecks dropped, held props kept clickable; details below). Tracks made before
> this keep their outlines unchanged. To trace a new track exactly as before, set
> the object's `select.cleanup` to `{ keepRatio: 0, holeRatio: 0, minArea: 0,
> near: false }`.

SAM 3 video follows a selected object through a place loop. The player uses its
outline at the current video frame, so the click target moves with the object.
Tracking is optional: fixed outlines from `node world select` keep working.

First render the loop and have its take approved in `node world review`. The
object needs a `select` in `world.yaml`, just as it does for a still outline:

```yaml
select:
  positive: [[0.4, 0.5]]
  negative: [[0.8, 0.1]]
```

Points are fractions of the video's width and height. They refer to frame zero
by default. Use the original loop when choosing them. Text or a box can also
select an object; video tracking follows one object per request.

Quote the exact loop before spending, then submit:

```bash
node world track my-world --only harbour-boat --quote
node world track my-world --only harbour-boat
node world build my-world
node world play my-world
```

Inspect the moving outline through the whole loop, including when the object
passes behind something and when playback wraps. Its label stays in its planned
position; the outlined click target follows the video. The source still and
approved film stay unchanged.

Use `--frame 24` to select on zero-based frame 24 instead of frame zero.
`--object-index 1` chooses the second returned object when a text selection finds
several matches; the default is zero. Omitting `--only` tracks every selected
object in places with approved loops. Each object is a separate request. Limits
are 30 seconds and 900 frames per source, with its exact resolution, frame count
and frame rate preserved. The result is a hard mask; it carries no audio.

The command prints an estimate and uses the same account and billing choice as
the Kit's other requests. `--quote` makes no model request. Completed tracking
is reused while the loop, selection and cleanup settings match. A new approved
loop or changed selection needs new tracking. `--redo` explicitly requests
another take; it preserves previous artifacts.

If the command is interrupted, run it again. A known project is collected again,
including a missing local download, without another generation. An uncertain
submission stops with a message: keep its receipt and reconcile the project
before making another request. Changing the clicks cannot bypass that record.
If an older selection already has a submitted project, it is collected first.

If a submitted project is over 24 hours old and Sogni confirms it is no longer
live and has no stored result, the Kit marks its receipt expired and stops.
Change the selection or run again with `--redo` to request another mask; the
old receipt stays on disk, with what was known before the expiry kept beside it.
A failed lookup alone never permits another request. Sogni only answers these
lookups for the account that submitted the project, so the Kit records that
account and expires a receipt only while you are signed in as it. A receipt
from another account stays submitted: sign in as its account to collect it. A
receipt made before the Kit recorded accounts takes the signed-in account the
first time Sogni answers for its project.

Completed tracking is never asked for again. If its outlines file is missing,
`node world track` traces it again from the mask on disk without a request. If
only the mask is missing, the outlines keep working in the build and the
command fetches the mask again from the same project; when Sogni no longer has
it, the command warns and carries on with the other objects. Restore the file
from a backup if you need it.

The moving outline is traced for clicking, not for compositing. In every frame,
pieces of the mask under 1.2% of the main piece are dropped, and so is any piece
that is far (more than 8% of the frame's longer side) from both the main piece
and the object's approved still selection, so a fleck elsewhere in the scene
never flashes on and off while the object itself can travel anywhere. Holes up to
a fifth of the object are filled, so a prop a figure holds stays clickable; a
larger opening, such as the middle of a ring, stays open. Specks under 16 px² are
not drawn. Each frame is judged on its own, so a piece right at a threshold can
come and go between frames. The delivered mask under `selections/video/` is kept
exactly as Sogni returned it. An object's `select.cleanup` overrides `keepRatio`,
`holeRatio` and `minArea`, and `near: false` keeps pieces wherever they are;
changing `select.cleanup` asks for new tracking (and a new still outline). Tracks
made before this rule keep the outlines they were traced with.

A frame with no outline means the object is out of view there: the camera has
moved off it, or something covers it completely. Nothing is drawn and nothing
takes a click until it comes back. Track the neighbours of a moving object too.
If one object's still outline is cut around another (a wall with a hole where a
person stands), or holds it (a person whose outline includes the hand that a
second object tracks), a still neighbour keeps showing the moving object's old
shape while the object itself moves on.

Receipts live at `selections/<place>-<object>.video.json`, with numbered attempt
records, source hashes, the delivered mask and frame paths under
`selections/video/`. The Kit verifies the downloaded bytes against the worker's
source and timing receipt. A build uses tracking only when the approved loop and
selection still match; stale tracking stays on disk and is omitted from the
world. Only the frame paths enter `build/world.json`.
