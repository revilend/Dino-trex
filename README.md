# Pixel Dino: Parkour Run

A single-file parody of the Chrome offline T-Rex runner: **one self-contained
`index.html`** with HTML5 Canvas + vanilla JavaScript. No libraries, no build
step, no image assets — the sprites are drawn as rectangles and every sound is
synthesized with the Web Audio API.

Open `index.html` in a browser and you're playing. That's it.

This isn't an endless runner: it's a **100,000-metre journey** to the 7G Wi-Fi
Tower, with **five boss gates** on the road and a **checkpoint every 10,000m**
so a crash is never a total loss. Finish it and you can keep going in
**Legendary Overdrive**; set a tag and you can see where you rank on the
**global leaderboard**. Inside the Android app it also **signs you in silently
with Google Play Games** on launch, files your distance, skins and Wi-Fi coins to
the **Play Games cloud save**, unlocks **seven achievements**, and sells **DINO
PRO** as a one-time **Play Billing** purchase. In a browser every one of those
steps quietly does nothing, and the game is completely unlocked.

## Run it

```bash
npm run dev        # or: node server.mjs   (serves on $PORT, defaults to 5173)
npm test           # headless harness: 1028 checks across physics, input, audio,
                   # the shop, bullet time, the five bosses, the checkpoints,
                   # the power-ups, the 100,000m finish, the menus, mobile,
                   # the landscape fullscreen layout, the Play Games silent
                   # sign-in and cloud save (against a stand-in host AND a cold
                   # boot), the app name in every
                   # place Play and Android read it, and the PWA manifest /
                   # service worker / icons that make the game installable and
                   # AAB-ready
```

Any static file server works — or double-click `index.html`.

## Install it as an app

The game is a normal web page first and an app second — and a game about being
**offline** should genuinely work offline. It ships everything a browser needs
to install it:

- a **`manifest.webmanifest`** asking for `display: fullscreen` and
  **`orientation: landscape`**, so an installed APK (whether Chrome's own
  WebAPK or a Trusted Web Activity) launches the device **locked to landscape,
  with no status bar** — and falls back to `standalone` if fullscreen is refused;
- a **service worker** (`sw.js`) that caches the shell, so the game boots with
  no network at all;
- **real PNG icons** — 192, 512, a `maskable` 512 that survives Android's
  circular crop, a 180px Apple touch icon and a 1024px source — rasterised
  straight from the game's own sprite table by `node make-icons.cjs` (a
  hand-rolled PNG encoder over `zlib`; still zero dependencies);
- a **`⬇ INSTALL` chip** in the top bar that appears only once the browser has
  actually offered an install prompt, and calls it for you;
- a **`theme-color`** that follows the sky, so the Android status bar turns dark
  at night with the rest of the world;
- **safe-area insets on `<body>`**, so a notch, a rounded corner or a gesture bar
  can never clip the 16:9 game box, the HUD or the touch pad — the box is
  measured *inside* the insets rather than centred over them.

The worker is deliberately **network-first for the page itself** — an online
visitor always gets the newest build, and the cached copy is only there for
when the signal drops. Icons and the manifest are cache-first, because they
never change shape.

That is also exactly the installability checklist a **Trusted Web Activity**
enforces before it will hand your site to Android as a native app, which is why
this repo is ready to be packaged into an **Android App Bundle**: see
**[ANDROID.md](ANDROID.md)** for both routes — Bubblewrap/TWA (wrap the hosted
URL) and Capacitor (bundle the files into a self-contained app) — with
copy-pasteable commands, the `assetlinks.json` digital-asset-links step that
removes the URL bar, the `bundleRelease` signing setup Play actually needs, the
`@capacitor/assets` step that turns the 1024px icon into every Android mipmap,
and a release checklist that maps each Play requirement to the file that
satisfies it.

**Landscape really is full-bleed.** The touch bar lives *inside* the game box, in
the empty strip below the road line (the bar is 15.5% of the game height and the
road sits at 160 of 216 world units, so there is a 26% band to sit in) — which
means the extra band the layout reserves under the game is reserved **in portrait
only**. In landscape a phone gets the whole 16:9 box, edge to edge, with no
black bars down the sides. That band used to be reserved in both orientations,
which silently shrank the landscape box to ~57% of the width; the harness now
asserts the landscape box fills the viewport.

### It turns itself

No button, no prompt, no "rotate your device" overlay. Two rules, and nothing
else:

1. **A coarse pointer held in portrait gets the box rotated 90°.** The wrapper
   is sized to the screen's dimensions *turned on their side* and then rotated
   into place, so a 402×891 portrait viewport presents the game as 891×402. That
   swap is the entire trick — it is asking the browser for landscape without the
   device ever physically turning.
2. **The first touch anywhere asks for fullscreen and locks the orientation**,
   from inside that gesture, because both calls are user-activation-gated and a
   request made a frame later is silently refused. A browser with no
   `orientation.lock`, or no `requestFullscreen` at all, still plays fine.

A mouse in a tall desktop window is deliberately **left alone** — rotating that
would be a bug, not a feature. When the phone physically turns, `rot` flips back
on its own.

The part that is easy to get wrong, and that the harness spends 20 checks on:

> **A 90° CSS transform does not change what `getBoundingClientRect` reports.**
> It returns the *axis-aligned box of the rotated result* — for a landscape box
> turned inside a portrait screen, a completely different rectangle from the one
> the player is looking at. Subtracting `rect.left`/`rect.top` from a touch puts
> every tap a whole screen out of position.

So `toWorld()` undoes the rotation by hand, working in the rotated frame's centre
(which a rotation about the centre preserves) and mapping through the inverse:

```js
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
const dx = e.clientX - cx, dy = e.clientY - cy;
// inverse of rotate(90deg): (dx,dy) -> (dy,-dx)
const ux = dy, uy = -dx;
const bw = r.height, bh = r.width;      // the box, pre-transform
return { x: (ux + bw / 2) / k, y: (uy + bh / 2) / k };
```

The swipe handler un-turns its **delta** the same way, because "down" for the
player's thumb is screen-*left* once the box is turned. The harness checks both
directions of that — dragging the other way must *not* register, which is what
proves the un-rotation is actually happening rather than the test passing by
accident.

The only thing that is *not* here is the Android toolchain itself: this
workspace is a Node.js image with no JDK, Gradle or Android SDK, so the build
itself needs Android Studio or CI.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump / backflip double-jump | `Space` · `W` · `↑` · `K` | **tap anywhere on the field**, or **JUMP** |
| Slide / rail-grind a cactus | hold `↓` · `S` · `A` | hold **↓ GRIND**, or drag down |
| Perfect parry | `C` | **PARRY** — double-tap for the Laser Roar |
| Rocket (or a pistol round, while the belt is loaded) | `F`, or `X` for the pistol alone | **ROCKET** |
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

### The pistol

A red crate — rarer than the hat, and it **never spawns while your belt is
already loaded** — gives you **12 rounds**. From then on the dino walks the road
with a pistol held out in his forward hand, muzzle and all, and **the ROCKET
button throws it**: press and a bullet leaves the barrel; empty the belt and the
same button throws the missile again. One control, two tools.

That is deliberate. The pistol is the obvious thing to want a *seventh* button
for, and a bar that reflows is a bar whose hit targets move under the player's
thumb — so the bar stays exactly six buttons long and the fire button grows a
second weapon instead.

The difference between the two is not cosmetic:

| | **Pistol** | **Rocket** |
| --- | --- | --- |
| Costs | one round (you have up to 99) | one of `AMMO_MAX` rockets |
| Rate | one shot every 220ms | one every 250ms |
| Hits a boss for | 1 | 1 |
| Pays an obstacle | **+10** | **+25** |
| Screen shake | a nudge | a slam, with the screen flash |
| Sound | a short dry crack | a swept roar with a tail |

So the pistol is the right tool for the first 10,000m, where a cactus every
few seconds costs you a missile and a fifth of your points; the rocket is the
right tool for the five gates. Both are live at once — that is what the belt is
for.

The gun is drawn **after** the body, so it reads as being held rather than
tucked behind, and it turns with the dino through a backflip — a gun that stays
upright while he is upside down is the oldest tell of a prop that was bolted on
instead of animated. Press `X` to fire it directly on the keyboard. The harness
checks every rect of the sprite's own pixel table appears in the frame, which is
a real check: a `SPT` call that never runs paints nothing while still leaving
`P.gun` full of rounds.

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
                                                     SLOW 5.8s
  CERTIFIED LEGEND                                  LASER 4.2s
                                                     COMBO x3
                                                    ▰▰▰▰▰▰▱▱▱▱
```

- **Top left:** the Wi-Fi coin wallet (with its `x2` PRO tag), the rocket
  counter, the hoverboard stock and the incognito timer, on two rows.
- **Top centre:** the progress bar and its `%`, the `100,000m` label, and the
  checkpoint / best-metres line underneath.
- **Top right:** the high score over the running score, then the two
  limited-weapon recharges (`SLOW 5.8s`, `LASER 4.2s`) on a line each, and —
  **only while a grapple is in the air** — `COMBO x3`: the kill-chain the rope
  is keeping alive, with a bar under it for the remaining combo window, which
  **drains as you swing** and is refilled the moment you detach. It rides a band
  of its own so it can never touch the recharge lines above it, which the suite
  proves by reconstructing the boxes and asserting they do not overlap — and by
  checking the bar is as full as the window it is holding. The whole cluster sits **below** the DOM
  chips (`👑 GO PRO` / `PAUSE` / `SOUND`) rather than under them. While a
  full-screen panel is open the chips leave entirely, because a panel is 213 of
  the 216 world units tall — the chips are not *near* it, they are inside it,
  and they were printing `👑 GO PRO / PAUSE / SOUND` straight across the DINO
  PRO panel's own `ACTIVE` label. They come straight back when it closes.

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

Reach **100,000m** and the run stops dead — no scrolling, no spawning, and every
control refuses, because the next ten seconds belong to the cutscene. When the
dialog arrives it does not only offer you a restart: it asks whether you want to
**keep going**, and [Legendary Overdrive](#legendary-overdrive--the-question-on-the-dialog)
is the answer.

### Six beats

| # | Beat | What happens |
| --- | --- | --- |
| 1 | **Arrival** | the 7G Wi-Fi Tower rolls in from the right edge and plants itself centre-screen, arcing sparks off its mast |
| 2 | **Flag jump** | the dino runs to the mast and backflips onto the antenna tip — a *scripted* arc, because the tip is 104 units up and a real jump tops out near 90 |
| 3 | **Signal restore** | the five arcs on the tower light one at a time, 20% → 100%, a chime on each, and the mast starts glowing gold when the last one lands |
| 4 | **Superhero landing** | he drops off the mast, lands on one knee and kicks up a cloud of pixel dust |
| 5 | **Victory outfit** | a crown drops 26 units onto his head and settles, shades snap on, and a red royal cape flutters out behind him |
| 6 | **Fireworks** | pixel fireworks and green-and-gold confetti, continuously, for good |

The timeline is six named windows in `CFG` (`CIN_RUN` … `CIN_MODAL`) rather than
one wall of drawing code, which is what lets the harness step to any beat
directly. It matters: a cinematic that can only be seen by playing 100,000m is a
cinematic nobody ever sees twice.

The dino's position is **scripted every frame** rather than simulated. A ten-second
arc that fights the physics is a scene that breaks the first time somebody retunes
gravity.

### The victory dialog

At the end of it, a Chrome dialog:

```
┌─────────────────────────────────────────────┐
│ Google Chrome                            ✕ │  blue title bar
├─────────────────────────────────────────────┤
│   👑 YOU SURVIVED 100,000 METERS!           │
│   CERTIFIED LEGEND                          │
│   Extinction Cancelled. Dinosaurs Ruled...  │
│                                             │
│   TOTAL DISTANCE  100,000 M  TIME ELAPSED  8m 32s  │
│   BOSSES DEFEATED  5/5 ROUTER·QUEEN  BONUS  +1,000    │
│                                             │
│   ┃ 👑 EMPEROR T-REX SKIN UNLOCKED AND EQ. ┃ │  gold band
│   ┃ Do you want to continue running in     ┃ │
│   ┃   Endless Legendary Mode?              ┃ │
│   ┃ 🔥 MAX SPEED · 3x COINS · RANDOM GATES ┃ │
│   [ ▶ PLAY AGAIN ]    [ 🛒 OPEN WARDROBE ]  │
│   [ 🔥 CONTINUE RUNNING (ENDLESS)         ] │  the widest key on the dialog
│              [ 🏠 MAIN MENU ]              │
│   No cacti ... except the router.           │  post-credits
└─────────────────────────────────────────────┘
```

The **elapsed time** is a real measurement: `update()` counts milliseconds while
`G.state === "run"`, and `win()` freezes that number into the cutscene. A
distance with no clock on it reads as an abstraction.

The four stats run as **two label/value pairs a row** rather than four stacked
rows, which is the only reason the question below has room to be asked at all:
the dialog is 213 units tall in a 216-unit world, so it cannot grow a unit, and
everything that competes for its lower half has to share it.

### Legendary Overdrive — the question on the dialog

The finale used to end on a choice between *play again* and *open the wardrobe*.
But a player who has just earned a crown and a cape does not want either of
those two — they want to **keep running, wearing it**. So the dialog asks:

> **Do you want to continue running in Endless Legendary Mode?**

**🔥 CONTINUE RUNNING (ENDLESS)** is the widest key on the dialog, and it sits
below the two that were already there, because it is the one the dialog now
exists to ask about. Press it and the dialog closes, the road keeps moving, and
the counter starts climbing again: 100,001m, 100,002m, all the way to whatever
you can survive.

What changes, all of it in one function (`enterOverdrive()`):

| | Normal run | Legendary Overdrive |
| --- | --- | --- |
| Top speed | `9.6` | **`12.4`** (`CFG.OVER_SPEED`) |
| Wi-Fi coins | ×1 (×2 with PRO) | **×3** (×6 with PRO) |
| Bosses | five, at fixed distances | **random**, forever |
| Distance | stops at 100,000m | **unbounded** |
| Outfit | Emperor T-Rex, if you bought it | Emperor T-Rex, **plus the crown, shades and cape** |

Three details that are easy to get wrong and are each pinned by the harness:

- **The top speed eases in over 1.4 seconds.** A speed that jumps 30% inside a
  single frame reads as a bug, not as a reward — the ramp is a smoothstep from
  `MAX_SPEED` to `OVER_SPEED`, sampled off `G.overT`, the mode's own clock.
- **The three coins stack with PRO rather than replacing it.** A PRO player who
  keeps running is paid **six** a coin, not quietly demoted back to three by the
  mode that is supposed to be the reward. `coinMul()` is the one place that
  decides, and the HUD wallet prints the live rate.
- **The five fixed gates are disarmed for good.** `G.bossIdx` is pushed past the
  end of `BOSSES`, so the overdrive grows its own gate on a random 9–21 second
  timer — and the next one is only armed once the last is down, so you never
  meet two at once.

**🏠 MAIN MENU** is the way out: back to the title card, with the overdrive, the
parked tower, the cutscene and the checkpoint all put away. Nothing is banked
behind it, because an endless run has nothing to resume to.

The counter itself had to change too. The journey's metre readout was clamped to
`CFG.FINISH`, so the HUD would have sat at `100,000m / 100%` forever while the
run climbed past it — and a progress bar pinned at 100% next to a number still
rising is the one combination that reads as a bug. In the overdrive the bar
relabels itself **ENDLESS** and follows the live distance.

One genuine bug fell out of this: `save.bestM` — the furthest run you have ever
made — was only ever written by `win()`. A run that died at 96,000m recorded
nothing at all, and neither does an endless one. It is now written on **every**
crash, which is what makes "how far did you get" mean anything before you finish
the journey.

## The Global Leaderboard

A real server, not a list of invented rivals. The board is a **sorted set in an
Upstash Redis database**, read and written straight from the browser with
`fetch` — no SDK, no npm, no backend of our own, so *one file, zero
dependencies, no build step* survives the feature. Redis does the sorting, which
is what makes the table genuinely global and genuinely ordered by the server
rather than by whoever rendered it.

> **To switch it on, paste two values** into the `LB` block near the top of the
> script — Upstash console → your database → Connection → **REST URL** and
> **Token**. Until they are there the board says `OFFLINE · NO LEADERBOARD
> ENDPOINT IS CONFIGURED`, which is the point: a leaderboard that cannot be
> reached must *say so* rather than show an empty table, because an empty table
> reads as "nobody has ever played this game", and that is the one lie this
> panel is not allowed to tell.

```
┌───────────────────────────────────────────────┐
│ 🏆  GLOBAL LEADERBOARD                        │
│ ● LIVE  ·  5,127 RUNS FILED                   │  the server answered
│ RANK      PLAYER               METRES         │
│ 🥇        ZEPHYR               240,500m       │
│ 🥈        NOVA                 198,300m       │
│ 🥉        REX                  150,000m       │
│ 4         BYTE                   99,000m       │
│ …                                              │
│ ┃NOVA            ← YOU          198,300m     ┃│  YOUR row, always pinned
│ [ 🔄 REFRESH ]             [   CLOSE   ]      │
│ ┃YOUR GLOBAL RANK     #2  ·  198,300m        ┃│  the server's own answer
└───────────────────────────────────────────────┘
```

### Your tag

Asked for once, on first launch, and again from the **👤 TAG** button on the
title card or a crash card. Up to twelve printable characters, trimmed, saved in
`localStorage`, and printed beside your record with the **skin you were wearing
when you set it** — on both the title card and the game-over card.

Typing is the one thing a canvas genuinely cannot do well, so the field is a
**real `<input>`** placed over the canvas's own drawn field: transparent ink, no
platform caret (the game draws its own, blinking), and sized from the same world
coordinates **in percentages of the 16:9 shell** — so the two cannot drift out of
register at any screen size, with no resize handler. That is also the only way a
phone gives you a keyboard at all.

**And the field is not part of the game's gesture surface.** The wrap listens for
touches to turn a tap into a jump, and it `preventDefault()`s them so the
browser's own gestures stay out of the way — which, applied to the field, meant
every touch on the tag was swallowed *before* the browser could focus it or raise
the soft keyboard, leaving a phone player with a field that simply did not type.
`#namebox` is now in the same "hands off" set as the pad and the top bar, so the
platform owns the field and the game owns the road: a touch on the field is never
prevented, a touch on the road still is, and a tap on the panel *around* the
field asks for the keyboard again. The harness checks all three — the last one
because the panel's own comment had promised that tap for a while and nothing was
doing it.

It is skippable, because a player who does not want a tag must never be trapped
in a panel. **SKIP** is the one key that means *no tag*. **Enter**, **SAVE &
PLAY** and **`Escape`** all **commit whatever is in the field** — and that last
one is a fix, not a detail:

> `Escape` is what the Android soft keyboard's **BACK** key sends. It used to
> discard the typed text and leave `save.name` at its previous value, so a phone
> player who typed a tag, dismissed the keyboard with BACK and expected to keep
> it lost it silently — and then crashed, got asked for the tag *again* on the
> crash card, and was still running under the old one. **`Escape` now commits,
> exactly like `Enter`**, and the panel says so: *"TYPE, THEN ENTER — ESC KEEPS
> IT TOO"*.

The panel is also **asked once per session**, whichever way it was answered.
`G.nameAsked` is set by every exit, so the first crash no longer pops a question
a player has already answered once — which is how a panel turns into something
you tap through.

And the flow is tested as one sequence rather than in pieces, because every way
out of this panel used to be a way to lose what was typed: type a tag containing
an **`X`**, get out with `Enter`, and press **`X`** for the pistol in the very
next breath. The harness proves the key reaches the game, that `X` is a *letter*
while the panel is open and a *weapon* the moment it closes, and that the real
`<input>` is handed back (`blur`, `display:none`, and `body.typing` removed) on
all four exits — Enter, the button, Escape and SKIP.

### What gets filed, and when

A **new personal best**, and only a new personal best, is filed on the server —
automatically, at the moment you crash. A worse run has nothing to say to a table
of bests. **🔄 REFRESH** re-asks the server rather than redrawing the last
answer.

### Two details that are easy to get wrong

**An entry is keyed on the TAG, not on name-and-skin.** The sorted set's member
is the tag alone and the skin lives in a hash beside it. Key it on both and
changing skins silently files a second row for the same person.

**`ZADD` is an overwrite, not a maximum.** A plain `ZADD key score member`
*replaces* the score, so a player who crashed at 12,000m after a 240,000m run
would erase their own record and the board would become a table of latest
crashes. The game sends **`ZADD key GT CH score member`** — raise the score only
if the new one is greater, and only report genuinely new members. That is the
whole difference between a leaderboard and a list of last crashes.

A skin id that arrives over the network is **checked, not trusted**: an entry
claiming a skin the game has never heard of falls back to the classic rather
than throwing on a missing sprite and taking the frame down with it.

### Being straight about what this is

The Upstash token has to be readable by every client, so **anybody can edit the
page and submit a fake distance**. That is the same trade every browser-only
leaderboard makes — Dreamlo, which was measured against this, has exactly the
same hole and a decade of complaints about it. It is fine for an arcade
high-score table. It is **not a prize table**, and the only honest fix for that
is a server that verifies the run — which would mean this file no longer being
the whole game.

You are paid **+1,000 bonus coins**, and the **GOLDEN CROWN DINO** — the exclusive
crown-and-aura skin — is unlocked *and equipped*, then persisted, so it survives a
relaunch. The **CERTIFIED LEGEND** title sticks to the title screen from then on.
Beating the run also clears your checkpoint, because there is nothing left to
resume.

The dialog owns the screen, so it takes the same rule the shop and the VIP panel
use: while it is open the `body` carries the `modal` class, which fades out the
touch pad and the top-right chips. A panel 213 units tall in a 216-unit world has
nowhere else for them to go.

> The post-credits line reads *"No cacti or pterodactyls were harmed in the making
> of this run… except the router."*

## Google Play Games: silent sign-in and cloud saves

Inside the Android APK the game signs the player in **by itself, at launch**, and
files progress to the Google Play Games cloud slot. In a browser it does neither,
and you cannot tell the difference.

### One object, four methods

The Android host injects a single object into the WebView and the game talks to
nothing else. That is the entire contract:

```js
window.PlayGames.autoSignIn()           // -> { playerId, gamerTag, iconUrl }
window.PlayGames.loadSnapshot(slot)     // -> the object you last saved
window.PlayGames.saveSnapshot(slot, o)  // -> acknowledged
```

`window.Capacitor.Plugins.PlayGames` is accepted as well, because there are three
sane ways to wrap a web game in an Android app and two of them name the bridge
differently. **The full host contract, in Kotlin and in Java, is in
[ANDROID.md](ANDROID.md#the-play-games-bridge).**

The adapter treats the bridge as *optional* in the strict sense:

- it is **detected, never assumed**, and it is never `await`ed by anything —
  the title card is already up and playable while the sign-in is in flight, and
  still playable if it never comes back;
- **every bridge call is raced against a 2.5-second timer**, so a wedged Play
  Services costs one timeout and cannot hold the title card hostage;
- **every field that comes back is validated, not trusted.** A Player ID must be
  4–24 digits, a GamerTag is trimmed to the same 12 printable characters the
  leaderboard uses, and an icon URL must be `http(s)`. This is the only value in
  the game that arrived from somewhere we do not control, and it goes straight
  into a save file, a cloud slot and a hashed avatar;
- **it never throws.** No bridge, a bridge that rejects, a bridge that hangs, a
  bridge that answers `{}` — all of them resolve to *nobody*, and the game
  carries on.

### The fallback is not a lesser path

With no bridge — a desktop browser, a hosted preview, a PWA, a plain TWA — the
game uses the nickname you saved yourself, or `Dino_Player`. It is the **same
line in the same place on the same card**, so a browser player never sees a gap
where an account would have been:

```
┌────────────────────────────────────────────────────────────┐
│ ▓▓ 🎮  REX_77                    PLAY CLOUD ON             │  the title card
│            PIXEL DINO                                       │  (icon, GamerTag,
│        P A R K O U R   R U N                                │   cloud flag)
│ …                                                          │
```

Connected, the top of the card carries the official **GamerTag** and the card is
flagged `PLAY CLOUD ON`. Not connected, the flag reads `OFFLINE MODE`. Nothing
else about the menu changes, and the line the identity sits on is measured
against the card's own box by the harness so a 12-character GamerTag cannot
overrun the edge or land on the wordmark.

### The welcome banner

```
        ████████████████████████████████████████████
        █  🎮 Welcome back, REX_77!              █   │  slides down from the top
        █  PLAYER ID 1234567890123456789  ·  CLOUD █   │  in Play's own green
```

It is **drawn, not native**, and that is a fact rather than a shortcut: a silent
sign-in cannot post a system notification without a consent flow the game has no
business triggering, and a web game inside a WebView has no way to ask for one.
So the game paints it itself — `#0b7a3e`, 264×36 world units, sliding in over
16 frames, resting, and sliding back out. It is a greeting, not a control: there
is no button on it, nothing is blocked, and `START` is pressable the whole time
it is on screen.

It is also **exactly once per session** (`PGS.said`), and it is armed only by a
sign-in that actually produced a player.

### The Gamer Icon is derived, not downloaded

A Gamer Icon is a network image, and this game has never loaded one: every pixel
it has ever drawn is a `fillRect`, which is the whole reason the APK is one file
with no assets and works with the radio off. So the icon is **derived** instead
of fetched — the Player ID is hashed with FNV-1a and 32 mirrored rectangles of
the result make a face:

- the **same player on every device** they sign in from,
- **nothing downloaded**, so it works offline forever,
- **two players never share one**, which the harness proves by rendering the same
  tile from two IDs and comparing the rasters.

The official `iconUrl` is still read and validated, and is available to the host;
it simply is not what is drawn.

### Cloud save

One slot, `pixeldino.save.v1`, and the payload is deliberately tiny — the three
things you would miss, plus enough to identify whose save it is:

```json
{ "v": 1, "gtag": "REX_77", "pid": "1234567890123456789",
  "bestM": 240500, "best": 9820, "coins": 1480,
  "owned": ["classic", "cyber"], "skin": "cyber", "pro": true }
```

It is pushed **automatically** on the only beats where something genuinely
changed — a **new personal best** on a crash, the **100,000m finish**, and
**unlocking or equipping a skin**. A worse run uploads nothing, because there is
nothing to upload.

### A merge may only ever add

The cloud slot is another machine's idea of your progress. It can be older, it
can be half-written, and on a shared device it can be somebody else's. So the
restore is deliberately one-directional:

| Field | Merge rule | Why |
| --- | --- | --- |
| `bestM`, `best`, `coins` | **max** | a stale slot can never lower a distance or empty a wallet |
| `owned` | **union** | a skin earned on this device is never dropped |
| `skin` | adopted **only while the local skin is still `classic`** | a stale slot cannot un-gild a dino you already earned the crown on |
| `pro` | **or** | you cannot lose the pass you paid for |
| `pid`, `gtag`, `v` | **ignored** | identity is read from the sign-in, never from the payload |

A corrupt or hostile slot is tested directly — negative metres, `"lots"` for
coins, a skin id the game has never heard of, a `pid` of `<script>` — and the
harness asserts that **not one thing is taken away and not one runtime error is
raised**. If this device is the one that is ahead, it wins the argument and
pushes straight back, so the two copies cannot sit disagreeing.

### What the harness actually proves

The bridge cannot be exercised for real in a workspace with no JDK, Gradle or
Android SDK, so the suite runs it two ways:

1. **A stand-in host** (`PG_HOST`) that records every call and holds the slot —
   the game calls it, parses its answers and decides for itself what to believe.
2. **A cold boot** (`bootWith`): a second, fresh VM running the real script with
   the host installed *before the first line of it executes*, and not one
   simulated tap. This is the only honest way to test *"on launch"*, and it
   asserts that the player is signed in, the cloud save is merged, the title card
   is up and the banner is sliding — all before anyone touches the screen.

Then the same cold boot is repeated **with no host at all**, and asserted to be
the same game minus the banner. Thirty-one checks, ending with a player who has
never installed the APK.

## Making money from it: Play Billing and Achievements

Google Play's payments policy is unambiguous — a digital item sold on Android
goes through **Play Billing**, and Stripe or Paddle are both rejected. So **DINO
PRO** became a **one-time non-consumable**: nothing expires, nothing renews,
nothing has to be cancelled. That is both the honest product and the simplest
thing that satisfies the policy.

> ### ⚠️ TWA cannot sell anything
>
> A **Trusted Web Activity** is a web page in a browser. It has no Play Billing,
> no Play Games, no Google account. The `Bubblewrap` route in [ANDROID.md]
> produces an APK that **cannot take money at all**.
>
> **Use Capacitor, or your own WebView app.** The `index.html` is identical
> either way — Capacitor only adds a native bridge.

### One more object, same shape

The repository already had `LB` (leaderboard) and `PGS` (Play Games); billing
is the third of the same kind:

```js
window.PlayBilling.queryPurchases(sku)      // -> { owned, price }
window.PlayBilling.launchBillingFlow(sku, page)  // -> { state, price }
```

`BILL.sku` is `dino_pro_lifetime` — **the product id as it appears in Play
Console**, and the only thing you have to change when you create it.

### The price is the store's, never ours

```js
if (/^[$\u20ac\u00a3]\s?[\d.,]+$/.test(r.price)) BILLS.price = r.price;
```

A hard-coded `$2.99` is a charge the player did not agree to the moment you run
a sale or open a new region. The host's price is used when it looks like a
price and **discarded when it does not** — the harness fires
`<script>alert(1)</script>` at it and asserts it is refused.

### Play's rule, and how it is enforced

> An app that cannot charge must not show a price.

So the rule is **conditional**, and both halves are asserted:

| Build | Header | The key | RESTORE | The line under the perks |
| --- | --- | --- | --- | --- |
| Browser | `FREE` | `ACTIVATE PRO` | absent | `FREE FOREVER — NOTHING TO PAY` |
| APK, store live | `VIP PASS` | `UNLOCK $2.99` | present | `ONE-TIME PURCHASE — … FOREVER` |
| APK, store broken | `VIP PASS` | `UNLOCK $2.99` | present | `PAYMENTS UNAVAILABLE — PLEASE TRY AGAIN` |

That third row is a bug the harness found. `activatePro()` used to fall back to
granting the pass for free whenever `BILLS.on` was false — which conflated *no
store exists* with *the store is broken*, and handed the paid thing to every
player with a flaky BillingClient. There are now two facts:

```js
BILLS.store   /* a BillingClient EXISTS  — never grant for free */
BILLS.on      /* it ANSWERED             — only now may a price be quoted */
```

**A free tier on an app that sells a purchase is exactly what the policy exists
to prevent.** So a broken store grants nothing, quotes nothing and says *try
again*.

### Restoring is automatic, because it has to be

A pass is restored **silently and unasked** the moment the store says the
account owns it — reinstalling, switching phones or a cleared browser must not
take something a player paid for away, and *asking* them to buy it again is the
single most reliable way to fail a Play review. The `RESTORE` key exists too, for
the account that asks.

Purchases are also **once**: pressing the key on a pass you already own never
reaches the store, because a non-consumable has nothing to re-buy.

### Achievements — free, and the cheaper half

Seven of them, each on something a player already does, and each worth more than
the price of the pass:

| id | | |
| --- | --- | --- |
| `CGI_CRASH` | FIRST 404 | Crash into the offline dinosaur. |
| `WIFI_1K` | FIRST SIGNAL | Reach the first 1,000m. |
| `BOSS_1` | GATE ONE | Beat your first boss gate. |
| `BOSS_ALL` | ALL GATES | Beat all five. |
| `GLORY_100K` | CERTIFIED | Finish the 100,000m journey. |
| `OVERDRIVE` | OVERDRIVE | Reach 250,000m in Legendary Overdrive. |
| `STYLIST` | WARDROBE | Own every skin. |

They are **evaluated, never sprinkled**: every moment the game has new numbers
calls `achCheck()`, which fires whatever is now true and has not fired yet. One
place to read, one place to test, and a new line of code that beats a boss
cannot forget to check. Fire-and-forget, once per session, and an achievement is
never worth an error or a retry.

They ride on the **same `PlayGames` object** as the silent sign-in, and a host
without `achievement()` disables the whole feature rather than half of it — the
harness asserts both.

### What the harness proves about money

A second set of hosts: `BILL_HOST` (a store that can be told to own, to cancel,
to fail, to hang, or to quote a different currency) and `BILL_HOST` installed
into the cold boot alongside the Play Games host. Twenty-four checks covering
the whole lifecycle:

- **no store** → free, and not one label quotes a price;
- **store live** → the pass must quote one, or it is not a product;
- **buying** → the flow launches for exactly `dino_pro_lifetime`, and the grant
  is identical to the free path because both run `givePro()`;
- **buying twice** → the second press never reaches the store;
- **cancelling** → grants nothing, says so, and the game stays playable;
- **store down** → grants nothing, quotes nothing, throws nothing;
- **store hanging** → timed out, and the game never locks;
- **reinstalling** → the pass comes back on its own, with the crown;
- **cold boot** → a paying account is restored, a non-paying one is not.

And a final cold boot **with no store at all**, asserted to be the same game —
because a checkout that cannot take money is worse than no checkout.

## Power-ups: the Hoverboard and Incognito Mode

Three rare drops float along the track, and all three are consumables you spend
rather than unlocks you keep.

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

That immunity is **height-independent, not just a side effect of being high
up**: the harness drops a cactus straight through the dino at the bottom of the
swing, where he is only a few units off the road, and proves he survives it —
then proves the *same* cactus is fatal the moment he is not hooking. Without the
second half the first would pass on altitude alone.

**The rope does not cost you your chain.** A grapple used to wipe the combo,
which made the hook a trap rather than an escape: swing over a cactus and the
kills you had banked died with it. Now the swing **spares the chain even as its
window runs out**, and the detach **tops the window back up** — so you come out
of the arc still holding exactly the combo you went in with, however long the
swing was. It is *spent*, not *extended*: with no swing behind it, the same
window still expires on its own, which is exactly what the harness checks
against.

The chain is **readable while it is being held**: for as long as the hook is in
the air and there is a combo worth keeping, a gold **`COMBO x3`** appears in the
HUD's right column, on a band of its own under the weapon recharges, with a
**bar underneath it for the remaining window**. It shows up when the swing
starts and vanishes the moment the rope does.

The bar is **honest, not decorative**: the window really does drain while you
fly, so the bar shrinks for real and can empty mid-swing — but empty is not
lost, because the detach refills it. A swing that outlasted the whole window
still hands you back a full bar on the road. It turns red under 30%. The harness
proves the bar is reading the real window rather than being decoration by
filling it from a full window and from half a window and asserting the two
widths differ by the ratio they should.

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

The **title card** is the front door. It frames the PIXEL DINO logo over a gold
`PARKOUR RUN` rule, and offers **▶ START** (or **▶ RESUME** when a checkpoint is
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

Eight two-line perks will not fit as stacked rows in a 216-unit-tall world, so
they run as a **two-column grid**: a 30-unit pitch, each badge with its own
column (`CROWN` is far wider than `2x`), and each name and blurb with a column
of its own. The spacing is measured on **real glyph boxes, not baselines** — the
harness reconstructs each label's box from its device-pixel anchor, its font
size and a true Courier advance, then checks that no two of them share a pixel.
That distinction matters: the first version of this grid compared *baselines*,
reported 6.1 units of clearance between the last blurb and the summary line, and
was visibly printing them through each other on a phone, where 0.7 world units
is under four device pixels. The label box now clears by 12.6.

One **"ACTIVATE PRO"** toggle flips it on, under a line that reads
**"FREE FOREVER — UNLOCKS EVERYTHING, NOTHING TO PAY"**. Nothing is charged and
nothing leaves the browser — `save.pro` is a local flag, and the chip settles into
a solid **👑 PRO** when it's active.

The panel used to advertise a **$0.99 one-time** unlock. That copy is gone, and
it is gone on purpose: the pass genuinely charges nothing, and Google Play's
payments policy does not allow an app with no billing integration to show a price
it cannot take. The panel now carries **no currency symbol and no price
anywhere**, and the test suite asserts that against both the source string and
the labels the panel actually paints — including a check that no label matches
`$` or a two-decimal number, so a price cannot quietly come back.

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

## The Play Store listing

Everything Play Console asks for before it will review an app is generated from
this repo by one command, with the same zero-dependency PNG encoder as the icons:

```bash
npm run store       # -> store/*.png
```

| Asset | Size | What it is |
| --- | --- | --- |
| `store/feature-graphic-1024x500.png` | 1024×500 | the listing banner: title, the road, the dino, and the journey's own progress bar |
| `store/screenshot-1-the-road-1920x1080.png` | 1920×1080 | mid-run, mid-jump, in daylight |
| `store/screenshot-2-boss-gate-1920x1080.png` | 1920×1080 | **Cyber Mecha-Rex** at 75,000m, at night, with its laser waves in the air |
| `store/screenshot-3-dino-pro-1920x1080.png` | 1920×1080 | the real DINO PRO panel, all eight perks |
| `store/screenshot-4-wardrobe-1920x1080.png` | 1920×1080 | the skin wardrobe, coins and all |

**The screenshots are the real game, not mock-ups.** The whole game is drawn with
exactly two canvas calls — `fillRect` and `fillText` — with no alpha and no
gradients, because every fade in it is a colour mix rather than a `globalAlpha`.
That means a frame can be rasterised *exactly* by implementing those two calls,
which is what `make-store-assets.cjs` does: it runs the real `index.html` in a
sandbox, steps the real simulation to a real state, and paints the real HUD, the
real boss and the real panels into a 1920×1080 buffer. Change the game and
re-run it and the listing follows.

Text needed a font and there is no font file to load, so the generator carries
its own **5×7 pixel face** whose advance is set to **0.6em — exactly Courier
New's**. That is not a cosmetic choice: it is what puts every label on the same
pixel the real game puts it on, so the panel layouts in the screenshots are the
real layouts rather than an approximation of them.

`store-look.cjs` decodes any of those PNGs back to ASCII
(`node store-look.cjs store/feature-graphic-1024x500.png 150 40`, with optional
`x0 y0 x1 y1` to zoom) so the artwork can be checked from a terminal, the same
way `shoot.cjs` checks the live game.

The harness asserts every one of them exists, is a real PNG, and is exactly the
size Play requires in 24-bit truecolour with no alpha.

### The AAB

Play does not accept an APK for a new app — it takes an **Android App Bundle**,
which Play then splits per device. `ANDROID.md` covers the whole route: the
`build.gradle` fields Play reads (`applicationId`, `versionCode`, `versionName`,
`targetSdkVersion`), `bundleRelease` with an upload key, `bundletool` for
sideloading a bundle onto your own phone, Play App Signing, and a GitHub Actions
workflow so the bundle can be built without installing Android Studio. The
release checklist at the end of that file lists every Play requirement next to
the repo file that already satisfies it.

### Privacy policy

**[PRIVACY.md](PRIVACY.md)** is the policy, and it is short because the facts
make it short: **no data is collected, and none is shared, because there is
none.** The game contains no `fetch`, no `XMLHttpRequest`, no `sendBeacon`, no
WebSocket, no tracking and no third-party scripts or fonts — `index.html` has no
external URL in it at all. Everything you play lives in a single
`localStorage` key, `dinoexe.save.v2`, on your own device, and never leaves it.
An offline game about being offline cannot phone home, which is the strongest
possible evidence for the claim.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire game. Self-contained and portable. |
| `server.mjs` | Zero-dependency static server for preview / hosting. |
| `smoke-test.cjs` | Headless harness that drives the real script in a VM (1028 checks). |
| `skin-card.cjs` | Dev-only: renders the skins as ANSI pixel art + `skins.svg`, and reports each accessory's alignment against the Chrome eye notch. |
| `manifest.webmanifest` | PWA metadata: **fullscreen + landscape** display, the icon set, theme colours, the app name. |
| `sw.js` | Offline service worker. Network-first for the page (never a stale build), cache-first for the icons. |
| `icons/` | App icons, generated — 192, 512, a maskable 512, a 180px Apple touch icon, a 32px favicon and a 1024px source. |
| `make-icons.cjs` | Dev-only: rasterises `SPR.classic_idle` into those PNGs with a hand-rolled encoder on top of `zlib`. No dependencies. |
| `png.cjs` | The shared PNG encoder + tiny raster (8-bit truecolour, no alpha), used by both generators. No dependencies. |
| `make-store-assets.cjs` | Dev-only: runs the real game in a sandbox and renders the Play feature graphic and four 1920×1080 screenshots. `npm run store` |
| `store-look.cjs` | Dev-only: decodes a `store/*.png` back to ASCII so the listing artwork can be eyeballed (and zoomed) from a terminal. |
| `PRIVACY.md` | The privacy policy: no data collected, `localStorage` only, no third parties. |
| `ANDROID.md` | How to ship it to Play as an **Android App Bundle** — Trusted Web Activity and Capacitor, `bundleRelease`, signing, `bundletool`, CI, and the release checklist. |
| `shoot.cjs` | Dev-only: renders any game frame as ANSI true-colour ASCII so the layout can be eyeballed from a terminal. `node shoot.cjs "<setup>" <frames> "<state expression>"` |
| `skins.svg` | Generated by `skin-card.cjs` — the skins at 7× with the Chrome frame ghosted underneath. |
| `package.json` | `dev` / `start` / `test` / `icons` / `store` scripts. No dependencies. |
