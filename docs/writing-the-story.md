# Writing the story

A world of your own photographs keeps the story you lived: put the places in the
order they happened and let the narrator tell it. Never invent a twist, a crime or
a secret about real people in real photographs.

A world you make up is different. The pictures, the films and the narrator's lines
all serve one story, and a visitor who clicks through it should feel what a good
film makes them feel: hooked in the first place, surprised in the middle, satisfied
at the end. This page is how to write that story before anything is painted, and
how to check it before anything is spent.

## Contents

- The promise: what kind of story it is
- The truth and the telling
- The shape across the places
- Twists that are fair
- Every click moves the story
- People, names and voices
- Endings
- The plot in world.yaml
- Check it: `node world story`
- A worked example

## The promise: what kind of story it is

Start from what the person asked for and name it plainly: a film-noir murder
mystery, a ghost story, a heist, a fable for children, a romance, a comedy, a
space salvage job. Each genre promises something, and the world must keep it:

| Genre | It promises | It needs |
|---|---|---|
| Murder mystery, noir | a death that matters, and the truth about it | suspects with something to hide, lies the visitor catches, clues they can piece together, a solution that turns the case over |
| Thriller, heist, chase | danger and a plan going wrong | a ticking clock, a betrayal, a narrow way out |
| Ghost story, horror | dread that grows | something wrong in the first place, worse in each one after, the thing itself seen late and briefly |
| Romance | two people and what keeps them apart | a meeting, a misunderstanding or a cost, a choice between them and something else |
| Comedy | escalation and payoff | a situation that gets worse in a funny way each place, callbacks to earlier jokes |
| Children's adventure, fable | wonder and a brave choice | a friend, a small danger, kindness rewarded, nothing cruel |

A world with no story, a place to wander, is fine too: say so, and skip the plot.

## The truth and the telling

Write down what really happened, start to finish, before you write anything the
visitor sees: who did what, when, and why. That is the plot's `truth`. The world
then tells it out of order, a piece at a time, and the visitor assembles it.
Everything they see and hear must agree with the truth, even the lies (a liar's
line is a clue when it contradicts something the visitor saw earlier).

## The shape across the places

A world has few places, so each one carries a lot. In order:

- **The first place hooks and starts the story.** Something is wrong or about to
  happen: a body, a summons, a theft, a door left open. The narrator's first lines
  say who the visitor is and what they want, in concrete words.
- **Every place in the middle changes what the visitor knows or wants.** A clue, a
  lie caught, a cost, a door that only opens now. The stakes rise as they go. A place
  that only adds atmosphere is a place to cut or to give a beat.
- **Something near the middle turns the story.** What the visitor believed is wrong,
  or someone they trusted is not who they seemed.
- **The end puts the visitor before a real choice** and pays it off: the truth told,
  a price paid, a door closed. Fatal choices (`ending` places) live here or at the
  turn.

Write each place's beat in one line (the plot's `beats`): what the visitor learns
or what turns there. No two places share a kind of beat: two interrogations, two
seductions or two bodies in a row make the middle sag.

## Twists that are fair

A twist surprises the visitor and, looking back, was there all along. For each:

- **Plant at least two clues before it lands**, each something the visitor can see
  in a picture or hear in a line: a glove on the wrong hand, a name signed in a
  register, a song the dead woman could not have known. One clue makes the twist a
  cheat; none makes it a coincidence.
- **Hide the clues in plain sight**: give each one another, innocent reason to be
  there, so it reads as detail the first time and as proof the second.
- **Never announce it.** A narrator line that hints too hard, or a label that names
  the secret ("Discover she's alive"), gives it away.
- **Let it recolour what came before.** The best twist makes the visitor replay the
  earlier places in their head: the client's grief was an act; the body was never
  hers.

Diabolical is good: a client who is the killer, a victim who staged the death, a
detective who signed the paper that caused it all. Arbitrary is not: whatever the
twist is, the truth has to make it possible and the clues have to point to it.

## Every click moves the story

A click is a promise that something will happen. Each object's film, close look or
crossing should do one of these:

- find a clue (the close look shows it and the narrator says what it means);
- catch a lie or turn a suspicion;
- cost the visitor something, or show what the danger is;
- show who someone really is;
- carry the visitor on to where the story goes next.

A click that only decorates (a light that comes and goes, a hand that points, an
object lifted and put back) wastes the visitor's trust. Its film starts and ends on
the same picture, so make it a close look that reveals something, or cut it.

## People, names and voices

- Give the cast in the plot: each person's one name and who they are. Use that name
  everywhere, spelled the same: captions, labels, narration, close looks, endings.
  If someone uses an alias, the alias is a clue, and the reveal says both names.
- Each person wants something and knows something. What they say follows from
  that, and stays consistent from place to place.
- The narrator speaks in the genre's voice (a noir detective's dry first person; a
  fable's warm teller), in short spoken lines that carry facts: a name, a time, a
  wound, a lie. Mood words ("mysterious", "eerie") are not facts. Lines stay under
  about twenty words, so they sound like speech.
- Writing the visitor sees (a note, a tag, lipstick on a mirror) is named in the
  picture's prompt and in the film's direction as what it reads, and it is part of
  the plot: a clue can be a word.

## Endings

Every ending is earned. A fatal choice is a real temptation, with a reason to take
it (the money, the easy way out, the person you love asking you to), and its card
says what it cost. The good ending pays off the twist and the choice the visitor
made. Each ending card is a few concrete sentences, not a moral.

## The plot in world.yaml

The story lives in the plan as `plot` (docs/world-yaml.md › plot). Visitors never
see it; every step after it reads it: the pictures are painted from its beats, the
films and lines are written to plant its clues, and the editor checks the words
against it.

```yaml
plot:
  promise: A film-noir murder mystery in the rain: a client with a secret, a city that lies, a reveal that turns the case over.
  truth: >
    What really happened, start to finish: who, when, why, and how it was covered up.
  cast:
    - name: Vera Lane
      who: the client in grey who hires you to find her missing sister; she is the one who made her disappear
  beats:
    office: The hook. Vera hires you to find her sister and pays in old bills; her glove is stained.
    pier: The turn. The sister's coat is pulled from the water, and Vera's lighter is in its pocket.
  twists:
    - twist: The client is the killer.
      at: pier
      clues:
        - at: office
          clue: Vera's left glove is stained dark at the palm, and she keeps it on.
        - at: club
          clue: The bartender says the sisters fought on Sunday, and Vera was there.
```

`node world lint` checks its shape: the places it names exist, each person has one
name, every place has a beat, and every clue comes before the twist it plants.

## Check it: `node world story`

Before you spend anything on films, run `node world story`. A Sogni LLM reads the
plot and then every word a visitor meets, in order, as a demanding editor: it lists
every person and every name used for them, every beat and what it adds, and then the
problems, each with a fix. Rewrite every "fix" (a twist with no planted clue, a
click that adds nothing, a beat used twice, a person called by two names, a line
that gives the game away) and run it again. "Consider" findings are yours to weigh.

## A worked example

A noir in eight places, told in order: office, street, club, dressing room, bar,
pier, precinct, the hill (with a death ending off the hill).

- **Promise:** a missing-person case that turns into a murder, and the client is
  the killer.
- **Truth:** Vera Lane drowned her sister Eleanor on Sunday night for the club and
  the insurance, then hired a detective to find her, so someone would be seen
  looking.
- **Beats:** the office, Vera hires you (her stained glove stays on); the street,
  the club's poster has Eleanor's name pasted over; the club, the bartender saw the
  sisters fight on Sunday; the dressing room, lipstick on the mirror reads "FORGIVE
  ME, V" (Eleanor knew); the bar, a cigarette girl sells you Eleanor's last
  matchbook, from the pier; the pier, the coat comes out of the water with Vera's
  lighter in it (the turn); the precinct, the lieutenant shows you the insurance
  policy, Vera the beneficiary; the hill, Vera offers you half to walk away.
- **The clicks:** the glove is a close look (the stain, and the narrator's line
  about which hand she favours); the mirror is a close look (the words); the
  matchbook is a collectible; the fatal choice is taking Vera's money (the death
  ending: she was never going to share).
- **Fair play:** the glove, the fight and the mirror all point at Vera before the
  pier, and each had an innocent reading when the visitor first met it.
