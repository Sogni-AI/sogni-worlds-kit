# A trailer for a world

A finished world makes its own trailer: its approved films are already the shots.
The kit has no trailer command; this page is the recipe an agent follows with
ffmpeg, and the mistakes that cost real trailers a retake. Build the world first
(`node world build`): cut from `build/films/`, which hold only approved takes.

## The shape

- **A rating card first, when the world is for adults.** An 18+ world opens on a
  card that says so, in the style of a restricted-audience preview card, held for
  about two seconds. Write the card's words yourself; a model spells only what it is
  given, and a card is the one place nobody forgives a misspelling.
- **The hook.** The world's first place and the first thing that goes wrong in it,
  with the voice that sets the story up (a narration line or a call).
- **A flash montage on the beat.** Short cuts of the best moments, each starting on a
  beat of the music: measure the tempo, then cut every beat or every other beat.
  Cut inside a film, never across one of its own crossings, and keep each flash in
  one shot.
- **One line to remember.** Stop the montage on a character's best line.
- **An end bumper.** The title, where to play it, and the real logo: a logo is a
  file someone gives you, never a picture a model draws.

## Sound

- **Never duck the music under a voice.** Lowering the whole song makes it pump.
  Instead, while someone speaks, lower only the music's 1–4 kHz band, where speech
  lives, by about 5 dB with 150 ms ramps, and lift the voice a little. Both stay full.

  ```bash
  # music.wav under voice.wav, the voice from 3.0 s to 5.2 s
  ffmpeg -i music.wav -i voice.wav -filter_complex "\
    [0:a]acrossover=split=1000 4000:order=4th[lo][mid][hi];\
    [mid]volume='1-0.4377*clip((t-2.85)/0.15,0,1)*clip((5.35-t)/0.15,0,1)':eval=frame[midc];\
    [lo][midc][hi]amix=inputs=3:normalize=0[bed];\
    [1:a]volume=4dB[v];[bed][v]amix=inputs=2:normalize=0,alimiter=limit=0.9[out]" \
    -map "[out]" mix.wav
  ```

  (0.4377 is 1 − 10^(−5/20): a 5 dB dip.)
- Level the finished trailer for the web, about −14 LUFS, true peak under −1 dB.

## Picture

- **One colour range before any join.** Some models deliver full-range video,
  others limited range. Join them as they are and ffmpeg picks one range for the
  whole edit: blacks turn grey, or greys crush. Convert every segment, and every card
  rendered from a picture, to limited-range BT.709 before it is joined or overlaid:

  ```bash
  # a full-range (pc) source; a limited-range one keeps in_range=tv
  -vf "scale=in_range=pc:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709"
  # and tag the output
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709
  ```

  Check one frame of each segment against its source: within a few levels.
- **A fade ends on the last frame.** A fade to black over `d` seconds in a clip that
  ends at `end` starts at `end − d − 1/fps`; started at `end − d`, the last frame is
  still dim instead of black.
- **Every shot is a finished film or a card.** A trailer never shows a frame from a
  rejected take, and never a model's attempt at the logo or the title.

## Check it

Watch it through with sound at full size. Then: the first and last frames are what
they should be (the card, the bumper, one black frame at the end); no black frame
reads grey; every cut lands on a beat; every word on screen is spelled right; and
the music never drops away under a line.
