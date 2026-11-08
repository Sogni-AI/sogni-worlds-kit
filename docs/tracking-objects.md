# Track a moving clickable object

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

Receipts live at `selections/<place>-<object>.video.json`, with numbered attempt
records, source hashes, the delivered mask and frame paths under
`selections/video/`. The Kit verifies the downloaded bytes against the worker's
source and timing receipt. A build uses tracking only when the approved loop and
selection still match; stale tracking stays on disk and is omitted from the
world. Only the frame paths enter `build/world.json`.
