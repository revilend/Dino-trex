# DINO.EXE — "Buffering Run"

A single-file parody of the Chrome offline T-Rex runner: **one self-contained
`index.html`** with HTML5 Canvas + vanilla JavaScript. No libraries, no build
step, no image assets — the sprites are drawn as rectangles and every sound is
synthesized with the Web Audio API.

Open `index.html` in a browser and you're playing. That's it.

This isn't an endless runner: it's a **100,000-metre journey** to the 7G Wi-Fi
Tower, with **five boss gates** on the road and a **checkpoint every 10,000m**
so a crash is never a total loss.

## Run it

```bash
npm run dev        # or: node server.mjs   (serves on $PORT, defaults to 5173)
npm test           # headless harness: 649 checks across physics, input, audio,
                   # the shop, bullet time, the five bosses, the checkpoints,
                   # the power-ups, the 100,000m finish, the menus, mobile and
                   # the PWA manifest / service worker / icons that make the
                   # game installable and APK-ready
```

Any static file server works — or double-click `index.html`.

## Install it as an app

The game is a normal web page first and an app second — and a game about being
**offline** should genuinely work offline. It ships everything a browser needs
to install it:

- a **`manifest.webmanifest`** asking for `display: standalone`;
- a **service worker** (`sw.js`) that caches the shell, so the game boots with
  no network at all;
- **real PNG icons** — 192, 512, a `maskable` 512 that survives Android's
  circular crop, a 180px Apple touch icon and a 1024px source — rasterised
  straight from the game's own sprite table by `node make-icons.cjs` (a
  hand-rolled PNG encoder over `zlib`; still zero dependencies);
- a **`⬇ INSTALL` chip** in the top bar that appears only once the browser has
  actually offered an install prompt, and calls it for you;
- a **`theme-color`** that follows the sky, so the Android status bar turns dark
  at night with the rest of the world.

The worker is deliberately **network-first for the page itself** — an online
visitor always gets the newest build, and the cached copy is only there for
when the signal drops. Icons and the manifest are cache-first, because they
never change shape.

That is also exactly the installability checklist a **Trusted Web Activity**
enforces before it will hand your site to Android as a native app, which is why
this repo is ready to be packaged into an **APK**: see **[ANDROID.md](ANDROID.md)**
for both routes — Bubblewrap/TWA (wrap the hosted URL) and Capacitor (bundle the
files into a self-contained APK) — with copy-pasteable commands, the
`assetlinks.json` digital-asset-links step that removes the URL bar, signing,
and the `@capacitor/assets` step that turns the 1024px icon into every Android
mipmap.

The only thing that is *not* here is the Android toolchain itself: this
workspace is a Node.js image with no JDK, Gradle or Android SDK, so the build
itself needs Android Studio or CI.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump / backflip double-jump | `Space` · `W` · `↑` · `K` | **tap anywhere on the field**, or **JUMP** |
| Slide / rail-grind a cactus | hold `↓` · `S` · `A` | hold **↓ GRIND**, or drag down |
| Perfect parry | `C` | **PARRY** — double-tap for the Laser Roar |
| Rocket | `F` | **ROCKET** |
| Bullet time (SLOW) | `Shift` (either) | **SLOW** |
| Grappling hook | `G` | **HOOK** |
| Laser Roar (6s recharge) | `R`, or double-tap `C` | double-tap **PARRY** |
| Deploy / stow hoverboard | `H` | **RIDE** |
| Context action (parry, else rocket) | `Enter` · `J` · `→` | — |
| Open the skin shop | `P` · `Esc` on the shop | **SHOP / WARDROBE** button on the cards |
| Open the VIP modal | `P` · `Esc` on the modal | **👑 GO PRO** chip, top right |
| Pause | `P` · `Esc` | **PAUSE** chip |
| Mute | `M` | **SOUND** chip |

On a phone every tap is mapped through the game's **CSS** scale, not its device
pixel scale, so buttons land exactly where they are drawn on any screen density
(this is why **CLOSE** works on a 3× phone).

**PARRY / ROCKET is context sensitive.** If anything is close enough to swat —
a cactus, a pterodactyl, a boss, or a boss energy wave — it performs a *timed
perfect parry*: a cyan shockwave that deflects the threat (+50) **and launches
the dino upward into a backflip**. A pulsing cyan ring in front of the dino is
the timing tell. With nothing in range it spends one rocket and fires the Pixel
RPG missile, which blasts the first obstacle (or the boss) it reaches (+25).
With an empty chamber it plays the dry *denied* blip and the button dims.

**SLOW** drops the whole world to **35% speed for 2 seconds** — obstacles, waves,
your own jump — then needs 6 more seconds to recharge. The button counts the
cooldown down and dims while it is charging. **PRO's overclock** halves that wait.

On a phone a single **responsive seven-button bar** appears automatically
(coarse pointer or first touch) along the bottom of the game box, in exactly
this order:

```
[ ↓ GRIND ] [ SLOW ] [ PARRY ] [ ROCKET ] [ HOOK ] [ RIDE ]  [   JUMP   ]
```

It is one horizontal strip that lives in the empty band below the road line, so
it never covers the canvas. **JUMP is the widest key on it and the only one
whose face is already filled**, because it is the one control you cannot play
without — but you rarely need it: **tapping anywhere on the field jumps**. Every
control is sized as a fraction of the on-screen game height, so the bar scales
with the canvas instead of drifting off it, and in portrait the game lifts up
and reserves the band it sits in. While a panel is open (shop, DINO PRO) the bar
fades out so it can never cover the panel's own buttons. Tap anywhere to start,
and to restart the instant you crash.

**Jumping is instant and always available.** The press is the jump — not the
release — so there is no lag and no "did my finger move?" window, a second press
while airborne is the 360 backflip double jump, and a downward drag is a slide.
A drag that starts as a slide **cancels the hop it began with**, so a swipe down
never leaves you mid-air. Deploying the hoverboard used to be a double-tap on
the field, which quietly ate every quick second tap — that shortcut is gone: the
board is **RIDE** or `H`, and the field belongs to jumping.

### Every ability, tested

One section of the harness walks the whole control surface in order and proves
**one press, one effect** for each of them — jump, the 360 double jump, slide and
its mid-air dive, the cactus rail-grind, the perfect parry (and its refusal when
nothing is in range), the rocket (and its dry-click when the chamber is empty),
bullet time, the grapple (and its `NO ANCHOR`), the Laser Roar, the
context-sensitive `ACTION` key, Incognito, the hoverboard, pause and mute. It
exists because "it feels broken" is usually one ability quietly doing nothing: the
kickflip used to spin the sprite while the board's own float zeroed the jump on
the very next frame, so the dino never actually left the deck.

## Pacing

The run starts at an easy walking pace — speed `4.4` — and **holds it for the first
10,500m**, so the opening is genuinely unhurried and the first boss is never a
test of reflexes. From there the speed follows a **smoothstep over the rest of the
journey** (`4.4 → 9.6` eased across the remaining 89,500m), so the curve is flat at
the start, steepest in the middle, and levels off before the tower. Gravity is
Chrome's `0.6` per 60Hz frame and jump velocity is still `10 + speed / 10`; a
fixed-timestep accumulator (max 8 substeps) keeps it all deterministic at any
frame rate.

### Obstacle density — the road is meant to breathe

Slower is not the same as emptier, so the spawner was pulled back separately.
Four levers, all measured by the harness rather than eyeballed:

| Lever | Before | Now | Effect |
| --- | --- | --- | --- |
| `CFG.GAPK` global gap scale | `0.8` | `1.15` | every gap on the road grows ~44% |
| `OBST.*.minGap` (cacti) | `120` | `165` | a wider floor before a cluster may appear |
| `OBST.ptero.minGap` | `150` | `200` | birds keep the most air around them |
| cluster width | `counts: [1, 2, 3]` | `counts: [1, 2]` | the three-cactus wall is gone |
| late-game pool | 3 cactus / 2 ptero | 4 cactus / 1 ptero | birds become the accent, not the course |
| gap jitter | `rnd(1.5, 1)` | `rnd(2.1, 1.2)` | clusters arrive in calm runs, not on a metronome |

The result, measured over 3,000 frames of real play with the spawner wrapped:
**~457 world units between obstacles at the start (~1.2 screens) and ~480 in the
late game, with the tightest squeeze anywhere at ~260** — up from roughly 150
before. Ground obstacles still outnumber birds 3-to-1.

## The 100,000m journey

A progress bar sits top-centre for the whole run:

```
 42%  ━━━━━━━━━━━━  📶  100,000m
```

The little dino walks the bar as you go, the bar turns gold at 100%, and the
distance, the percentage, your best ever run and your current checkpoint are all
printed around it. The bar is not just a readout — it is a map of the whole
journey:

- a **gold tick every 10,000m** — the ten checkpoints, which fill in as you pass them;
- a **red gate at each boss** (10k, 25k, 50k, 75k, 99k), turning **gold** the moment
  you beat that boss.

Distance in metres is the *only* thing that advances the journey — bullet time
costs you ground.

### The top strip is three columns that cannot collide

The HUD is built from one layout table (`HUD`), so nothing can silently drift
into anything else:

```
 LEFT  x 8..122      CENTRE                     RIGHT  right-aligned at 376
 ━━━━━━━━━━━━━      ━━━━━━━━━━━━━━━━━━━━━      ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1234  x4          40%  ━━━━┳━━━  📶 100,000m     HI 04820
  x2    3.0              CP 40,000m                      01268
  CERTIFIED LEGEND
```

- **Top left:** the Wi-Fi coin wallet (with its `x2` PRO tag), the rocket
  counter, the hoverboard stock and the incognito timer, on two rows.
- **Top centre:** the progress bar and its `%`, the `100,000m` label, and the
  checkpoint / best-metres line underneath.
- **Top right:** the high score over the running score, placed **below** the
  DOM chips (`👑 GO PRO` / `PAUSE` / `SOUND`) rather than under them.

The bands below stack in order and never touch — `toast`, then the flash
(`CHECKPOINT 40,000m` / `⚠️ ROUTER BOSS ⚠️` / `BULLET TIME`). The test suite
asserts it twice: once against the layout table, and once against the **labels
the frame really painted**, reconstructing each box from its device-pixel anchor,
its font size and a true Courier New advance. If two labels ever overlap, the
suite says which two.

## Checkpoints every 10,000m

Every 10,000 metres the game **banks a snapshot** into `localStorage`: your
metres and road position, distance, score, coins, rockets in the chamber, the
night phase, which bosses you've beaten, and your PRO revive. A gold
`CHECKPOINT 40,000m` flash and a chime tell you it landed.

Crash and the game-over card reads **`CHECKPOINT 40,000m KEPT`**. Then:

- **Space / tap / slide / RESUME** resumes the run *from that checkpoint* — same
  metres, same wallet, same ammo, same bosses beaten;
- **NEW RUN** throws the checkpoint away and starts again from 0m.

The title card offers the same choice: with a checkpoint banked it reads
**"CHECKPOINT 40,000m BANKED"** and grows its own **RESUME / NEW RUN** pair. The
checkpoint is only cleared when you beat the run (or deliberately start a new one),
so a crash never costs you more than the 10,000m since the last gate.

## The five gates

Each boss slams the brakes when you reach its mark: the screen shakes, a
two-tone siren wails, and **`BOSS n/5: NAME INCOMING`** flashes over the road
(the first gate shouts **`⚠️ ROUTER BOSS ⚠️`** instead). While one is alive **the
road stops advancing and no cacti spawn** — you cannot skip past it. It has an
on-screen red HP bar and a name.

| # | At | Boss | HP | Pays | What it does |
| --- | --- | --- | --- | --- | --- |
| 1 | 10,000m | **Wi-Fi Router** | 6 | 50 | the first gate, right where the speed ramp begins: the **`⚠️ ROUTER BOSS ⚠️`** alert, a red HP bar, a spinning buffering spinner and **red Wi-Fi pulses** from three heights |
| 2 | 25,000m | **Pterodactyl Queen** | 8 | 75 | **diving swoops** (gold telegraph bar first) and **minion swarms** |
| 3 | 50,000m | **Glitch Golem** | 10 | 100 | rears back, then slams the floor into two **shockwaves** |
| 4 | 75,000m | **Cyber Mecha-Rex** | 12 | 150 | 2× dino with a cyan visor; **laser blasts** and **fast dashes** |
| 5 | 99,000m | **The Extinction Meteor** | 7 | 250 | a burning rock on a **7-second fall**. Shoot it down or the web goes extinct |

Things worth knowing about a gate:

- **Rockets hurt them** (1 each) and **parries hurt them more** — a parry on the
  boss itself is 2, and deflecting one of the boss's own shots chips it for 1.
  You have to close the distance, or climb, to get in parry range.
- **A boss fight feeds you rockets, not coins.** The track drops a missile every
  half second or so, so you can never be outgunned by your own backpack. Kill the
  boss and the coins come back.
- Killing one drops its bonus coins **into the wallet and the score**, with a
  screen-shaking explosion, confetti and a victory flourish — and banks a
  checkpoint on the spot, so gate 1 banks your first 10,000m for you.
- Each boss has its own **death message** ("Crushed by a Glitch Golem
  shockwave", "Lasered by the Cyber Mecha-Rex", "Burned away by the Extinction
  Meteor", …).

The **meteor** is the one fight that is a race rather than a duel. It starts
above your rocket line, so you have to **jump to hit it** while it is high, and
**land to scoop the rockets** it keeps dropping — shoot it from the floor once it
closes in. The boss bar counts down: `IMPACT IN 5s`.

## The Grand Finale

Reach **100,000m** and the 7G Wi-Fi Tower rolls in from the right and parks beside
the track. Confetti rains, pixel fireworks burst, a victory fanfare plays, and the
screen proclaims:

> **YOU SURVIVED 100,000 METERS**
> **CERTIFIED LEGEND**

You are paid **+1,000 bonus coins** on top of everything you scooped, and the
**GOLDEN CROWN DINO** — the exclusive crown-and-aura skin — is unlocked for good
if you didn't already own it. The **CERTIFIED LEGEND** title sticks to the title
screen from then on. Beating the run also clears your checkpoint, because there
is nothing left to resume.

## Power-ups: the Hoverboard and Incognito Mode

Two rare drops float along the track, and both are consumables you spend rather
than unlocks you keep.

### Hoverboard

Press **`H`**, or tap **RIDE**, to deploy a board. If you have none
in stock the game says so instead of eating the input; press `H` again to stow it
and it goes back in your pack.

- **It floats.** The dino eases up to a hover height and holds it there, with two
  flickering jets under the deck and a trail of gold and cyan sparks.
- **It is meant to look like it is actually holding him up.** Three things do
  that work, and all three are load-bearing rather than decoration:
  - **a real suspension.** The deck is a spring-and-damper, not a string: a
    kickflip lands on it, the springs compress about three units under his
    weight, and then push him back to level and stop. He arrives with a kick,
    the deck dips, and the world settles;
  - **a pool of light on the road.** The deck throws a flat neon pool onto the
    tarmac directly below it, which tightens and fades as it climbs away. This
    is the cue that says *floating* louder than any amount of hovering, and the
    whole rig — deck, jets and dino — rises together through a kickflip, so the
    board is never left parked on the road under a spinning dino;
  - **jets that answer the throttle.** The two jets stretch as he leaves the
    deck and relax as he sinks back, the dino leans into the run (a little with
    the speed, a little against the suspension), the deck tilts with him, and
    the engine hum **climbs in pitch as the run speeds up** — the board has to
    sound like it is working.
- **Jumping is a 360 kickflip — and a real hop.** The deck is a launch pad, not a
  decoration: the dino leaves it with exactly the jump velocity he has on foot,
  gravity flies him, the sprite turns through a full 360, and the deck **rides up
  with him** and catches him on the way down. A second tap in mid-air is a second
  kickflip. That matters, because hovering is not dodging — you still cannot duck
  on a board, so the hop is the only way past a cactus, a bird, or a shockwave.
- **You still collect.** The board rides higher than the road, so the dino's reach
  hangs down under the deck and the low coin row is scooped up as you pass. The
  high row still wants a hop, exactly as it does on foot.
- **A rocket fired from the deck rakes the road.** Missiles leaving the dino's own
  hands are the little 18x5 rocket they always were; a missile launched from the
  board carries its blast all the way down to the tarmac, so a hovering dino does
  not sail over every short cactus on the track.
- **It eats one crash.** Hitting a cactus, a pterodactyl, or a boss projectile
  destroys the board in a shower of sparks, clears the hazard around you, and the
  run continues. Board gone, run alive. The next crash is a normal crash.
- A deployed board is **banked in your checkpoint**, so dying never costs you the
  board you were flying.

**Buying boards.** The skin shop has a **HOVERBOARD PACK** row under the wardrobe:
**3 boards for 30 Wi-Fi coins**, repeatable, and the row shows your current stock.
They also drop on the track roughly every eleventh pickup, so you are never stuck.

**PRO** starts every run **already flying** on a free golden hoverboard.

### Incognito Mode

A spy hat and sunglasses float past every so often. Scoop one and Chrome goes
**incognito** for **six seconds**:

- the whole world turns **Chrome's incognito grey `#202124`**, whatever the hour;
- the dino puts on a **fedora and dark shades** and fades to a translucent ghost;
- it is **completely intangible** — cacti, pterodactyls and boss fire phase
  straight through it and are dispersed harmlessly;
- a **countdown ticks down over its head**, and shimmers in the last second and a
  half so you know it is about to drop.

When the clock runs out the sky returns to normal and the dino is solid again. A
crash in the same frame it ends still counts, so do not lean on the last tick.

### The grappling hook

Press **`G`** or tap **HOOK** and a rope fires up to the nearest **cloud or
pterodactyl**, a bold red **`GRAPPLE!`** shouts across the screen, and the dino
swings forward through the air on a smooth pendulum arc. For **three seconds**
the swing carries you safely over every ground cactus, then it releases with a
**`NICE!`** pop-up and +60. With nothing overhead the hook refuses instead of
wasting the input (`NO ANCHOR`). You cannot grapple while riding the board —
stow it first.

**The sky is always stocked.** Pixel clouds drift across it on every screen,
including the title card, at a steady rate and in a band (`y 40..90`) chosen so
that a cloud is always **in reach of the rope** and always **clear of the road**
and of the dino's own jump arc. Up to seven share the sky at once. The rope
itself is a **solid ink line with a little slack in it**, drawn segment by
segment from the dino's hands all the way up to the cloud it caught, with a
hook biting into the cloud at the top — a continuous line reads as a rope in a
way a dotted one never does.

### The Laser Roar

Every kill — a rocket, a perfect parry, a rail-grind — chains a **combo**, and
**five in a row** sets off the **Laser Roar**. The dino pauses for a split
second, roars (`roar`), and a massive horizontal beam erupts from its mouth
across the whole screen, instantly vaporizing every cactus and bird on it into
glowing spark particles. You can also fire it on demand with **`R`**, or by
**double-tapping PARRY**.

**It is a limited weapon, not a button you can lean on.** The beam itself is
barely a second long; the **roar then needs six seconds to recharge**, and while
it is charging the HUD counts the clock down under the score (`LASER 4.2s`).
Press it early and it says so — `LASER RECHARGING 4.2s`, with the dry *denied*
blip — instead of firing. The recharge is **banked in your checkpoint**, so dying
is not a free reload. The one thing that ignores a warm charge is the five-kill
combo, because that is a reward for playing well rather than a button: even it
re-arms the clock, so the combo cannot machine-gun the screen either.

### Jump trajectory dots

While the dino is airborne a **dotted cyan arc** trails behind it — a short
history of its real jump heights, drawn as it rises and falls, and cleared the
moment it lands. It is the read that makes a double-jump line up.

## Wi-Fi coins, rockets and the skin shop

- **Wi-Fi coins.** Every couple of seconds the track gets a pickup: a run of
  three pixel Wi-Fi arcs at one of three heights (on the ground, a short hop, a
  full jump). Scoop one and the wallet in the top-left goes up, the score gets
  +1, and it chimes. The total lives in `localStorage`, so it survives every crash.
- **Rockets.** Every third pickup is a `[ROCKET]` box instead. It loads **three**
  rockets, shown as `xN` next to the rocket icon in the HUD (dimmed at zero, up
  to nine in the chamber).
- **Mystery boxes.** Alongside the coins the track floats three bordered power-up
  boxes: **`[H]`** stocks a hoverboard, **`[I]`** turns on Incognito Mode, and
  **`[ROCKET]`** carries the three rockets above. Each gets a halo so it reads as
  a power-up rather than a coin.
- **Skin shop.** The title, game-over and victory screens all carry **SHOP** and
  **GO PRO** buttons. The shop opens a pixel modal listing **twelve dinos** with
  live previews, laid out as a **two-column grid of four rows** — eight tiles a
  page, with **◀ / ▶ page turns** sharing the bottom row with CLOSE, so the
  wardrobe scales to any number of skins without a row ever running into the
  pack or the buttons below it:

  | Skin | Price | Look |
  | --- | --- | --- |
  | Classic Dino | owned | the untouched Chrome sprite |
  | Gentleman Dino | 50 | top hat and a golden monocle |
  | Cyber Dino | 100 | a glowing visor |
  | Crown Dino | 150 | a royal crown and a pulsing golden aura — or win 100,000m |
  | Pirate Dino | 200 | a red bandana, an eyepatch and a gold hoop |
  | Astro Dino | 250 | a space helmet with a cyan visor and a whip antenna |
  | Ninja Dino | 300 | a face wrap and a headband with trailing tails |
  | Wizard Dino | 350 | a starred cone hat and a long pale beard |
  | Samurai Dino | 400 | a red kabuto with horned gold maedate and a cheek guard |
  | Cowboy Dino | 450 | a wide dark hat, a gold band and a red bandana |
  | Viking Dino | 500 | a gold-rimmed helm with two horns and a pale beard |
  | Punk Dino | 550 | a red mohawk, a studded collar and a gold ear hoop |
  | Hoverboard Pack | 30 | **3 hoverboards** — not a skin, a consumable |

  Tapping a skin buys it (if you can afford it) or equips it, deducting the price
  and writing both the unlock and the equipped skin to `localStorage`. Skins are
  *composed onto* the real Chrome frames rather than replacing them, so every pose
  — running, blinking, ducking, crashing — and the backflip rotation all keep
  working with the accessory stamped on in head space. Nothing is drawn over the
  eye notch unless it is meant to be (the eyepatch and the visor are); the
  remaining hats are placed to land on the skull in **both** the standing and the
  ducking pose. The Crown Dino's aura is the one thing drawn live, so it pulses.
  The shop is fully keyboard-navigable: `↑`/`↓` step a row, `←`/`→` step a column
  — and stepping off the last tile of a page turns the page by itself — `Enter`
  buys or equips, `P`/`Esc` closes.

## The menus

Every panel is built from the same three pieces, so the game-over card, the shop
and the DINO PRO modal read as one family rather than three separate screens:

- **A raised card.** A hard 2px ink border, a soft drop shadow underneath and a
  hairline inner rule, with small gold (or red, on game over) corner ticks.
- **Physical buttons.** Idle buttons get a shadow, a top highlight and a bottom
  shade so they read as keys you can press; the active one fills with ink.
- **A heading with a rule** that runs out to the panel edge, over a content
  margin everything else sits inside.

The **title card** is the front door. It frames the DINO.EXE logo over a gold
`BUFFERING RUN` rule, and offers **▶ START** (or **▶ RESUME** when a checkpoint is
banked) next to **SHOP** and **GO PRO**. If a checkpoint exists the card also
grows a **RESUME / NEW RUN** pair, so you can pick up where you died or wipe the
slate without hunting for a menu. The **game-over card** is dressed as an
authentic Chrome dialog — a blue **`Google Chrome`** title bar over
**`Internet Connection Restored`**, then **`Goodbye!`**, the score, the distance
and the checkpoint you kept. Its buttons are **RESTART / RECONNECT**, and
**WARDROBE** / **GO PRO**; with a checkpoint banked it also grows a **NEW RUN**
button so you can throw the checkpoint away.

A test asserts every button in every panel stays inside that panel's box, and
that START / RESUME / NEW RUN each do the right thing — so a longer label can
never quietly push a button out of its card or off the screen again.

## DINO PRO

A glowing **👑 GO PRO** chip sits in the top bar (and on the title, game-over and
victory cards). It opens the VIP modal:

| Perk | What it does |
| --- | --- |
| **2× Wi-Fi coins** | every coin is worth double, every run (the wallet shows a `x2` tag) |
| **2 free revives** | a golden energy shield absorbs your first **two** crashes, clears the danger around you and throws you back into the air |
| **3 free rockets** | every run starts with three rockets loaded |
| **1 free golden hoverboard** | every run starts already flying on the board |
| **Coin magnet** | any Wi-Fi coin within **78 units** is reeled into the dino's hands, so the high row comes to you instead of being jumped for |
| **Overclock** | **SLOW** and the **Laser Roar** recharge in **half** the time — 3s and 3s instead of 6s and 6s |
| **Long Incognito** | the spy hat lasts **nine seconds** instead of six, with the fade scaled to the longer clock |
| **Golden Dino** | the 150-coin crown skin, unlocked instantly |

Three of those are new: the **magnet**, the **overclock** and the **longer
Incognito**, plus the revive count doubled from one to two. The panel lists all
eight in a **two-column grid** — eight two-line rows will not fit a 216-unit-tall
world, and the grid is what makes all eight readable at once.

Every one of them is a line of real code (`recharge()`, `spyMs()`, `magnet()`,
`CFG.PRO_REVIVES`), and the test suite asserts each one against the game's own
state — PRO's magnet really does collect a coin from the high row that a normal
run sails over, and PRO's `beamCd` really is half a normal run's.

The panel lists the Golden Dino as well as the hoverboard, because **ACTIVATE PRO**
unlocks both at once.

One **"ACTIVATE PRO (FREE TEST / $0.99)"** toggle flips it on. Nothing is charged
and nothing leaves the browser — `save.pro` is a local flag, and the chip settles
into a solid **👑 PRO** when it's active.

## Night phases and music

Every 500 points the run flips to night for a phase and back again: the whole
palette cross-fades to dark paper with light ink over ~0.35s (page chrome and the
on-screen pad fade with it), a crescent moon rises, a 16-star field starts
drifting and twinkling, and the clouds dissolve into the dark sky. The **music
changes with it**: the day loop (132bpm, walking bass + bright pentatonic arp)
hands over on the next bar line to a night variation — 100bpm, everything an
octave down, a sparse lowpassed lead, a detuned saw bass and a slow drone under
the bar — and the sound effects drop a fifth-ish with it. Crash at night and the
game-over card is dark too; a fresh run always starts in daylight.

## Audio

Every sound is synthesized live with the Web Audio API — no samples:

`jump` `djump` `land` `point` `die` `grind` `shoot` `boom` `parry` `coin` `ammo`
`buy` `deny` `click` `slow` `zap` `siren` `shield` `pop` `victory`
`board` `hum` `spin` `smash` `spy` `ghost` `hook` `roar`

`victory` is a seven-note fanfare with a bass hit; `siren` is the two-tone boss
alarm; `slow` is a descending sine sweep. The power-ups have their own voices:
`board` is a rising hover whoosh, `hum` the soft engine note while you fly, `spin`
a five-step chirp for the kickflip, `smash` the board breaking, and `spy` a soft
shhh as the world goes incognito. All of it runs through the same mute chip and
the same night-phase pitch drop.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire game. Self-contained and portable. |
| `server.mjs` | Zero-dependency static server for preview / hosting. |
| `smoke-test.cjs` | Headless harness that drives the real script in a VM (649 checks). |
| `skin-card.cjs` | Dev-only: renders the skins as ANSI pixel art + `skins.svg`, and reports each accessory's alignment against the Chrome eye notch. |
| `manifest.webmanifest` | PWA metadata: standalone display, the icon set, theme colours. |
| `sw.js` | Offline service worker. Network-first for the page (never a stale build), cache-first for the icons. |
| `icons/` | App icons, generated — 192, 512, a maskable 512, a 180px Apple touch icon, a 32px favicon and a 1024px source. |
| `make-icons.cjs` | Dev-only: rasterises `SPR.classic_idle` into those PNGs with a hand-rolled encoder on top of `zlib`. No dependencies. |
| `ANDROID.md` | How to wrap the game into a real Android APK — Trusted Web Activity and Capacitor, step by step. |
| `shoot.cjs` | Dev-only: renders any game frame as ANSI true-colour ASCII so the layout can be eyeballed from a terminal. `node shoot.cjs "<setup>" <frames> "<state expression>"` |
| `skins.svg` | Generated by `skin-card.cjs` — the skins at 7× with the Chrome frame ghosted underneath. |
| `package.json` | `dev` / `start` / `test` / `icons` scripts. No dependencies. |
