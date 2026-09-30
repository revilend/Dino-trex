# Privacy Policy — Pixel Dino: Parkour Run

**Last updated: 30 September 2026**

Pixel Dino: Parkour Run is a single-file HTML5 game. It has no accounts, no
servers, no analytics and no advertising. This document explains what that
means in practice, in plain language.

## The short version

- We **do not collect** any personal data.
- We **do not share, sell or transfer** any data — because there is none to share.
- Everything you play is stored **only on your own device**, in your browser's
  local storage, and never leaves it.
- The game works fully **offline**, which is the most direct proof of the two
  points above: an offline game physically cannot phone home.

## What the app stores, and where

The game keeps a single record in your browser's `localStorage`, under the key
`dinoexe.save.v2`. It contains only gameplay state:

| Value | What it is |
| --- | --- |
| `best` / `bestM` | your highest score and furthest distance |
| `coins`, `owned`, `skin` | your Wi-Fi coin wallet and your wardrobe |
| `music`, `sound` | your sound and music toggles |
| `pro` | whether the optional DINO PRO pass is switched on |
| `title` | a short custom title you type, if you use one (max 24 characters) |
| `champ`, `boards` | your championship count and hoverboard stock |
| `cp` | your most recent checkpoint (metres, score, coins, ammo, progress) |

The **DINO PRO pass is free and unlocks everything**. It is not a purchase, it
does not contact a payment provider, and it is stored only as a boolean in the
record above. **The app contains no billing code, no in-app purchases and no
advertising SDKs** — you can verify this yourself: `index.html` is the entire
game, and it contains no external URLs at all.

Because this data is local, it is not encrypted and it is not backed up. It is
lost if you clear the site's data, uninstall the app, or use private/incognito
browsing. That is a deliberate trade-off, not an oversight: a game that stores
nothing about you has nothing to leak.

## What the app transmits

The game makes **no network requests of its own**. It contains no `fetch`, no
`XMLHttpRequest`, no `navigator.sendBeacon`, no WebSocket, no tracking pixels
and no third-party scripts, fonts or analytics. The only network traffic is
simply your browser downloading the game's own files (the page, the service
worker, the manifest and the icons) from wherever the game is hosted — the same
as any web page you visit.

A **service worker** caches those files on your device so the game keeps working
with no connection at all. The cache is local and is cleared and rebuilt on
every update; nothing is ever uploaded.

## Permissions

The app requests **no device permissions**: no camera, microphone, location,
contacts, storage, phone state, vibration, advertising ID or user ID. It cannot
read anything outside its own saved record.

## Children

The game is suitable for all ages and collects no data from anyone, including
children. Since it has no accounts and no data collection, there is nothing for
a child to disclose and nothing for us to hold.

## Third parties

None. The game integrates no advertising, analytics, crash-reporting, social or
payment service, so no data is ever shared with a third party or transferred
outside your device.

## Your rights

Because no personal data is collected, there is no personal data to access,
correct, export, restrict or erase on request. Uninstalling the app, or clearing
the site's data in your browser, removes the single saved record permanently.
If you would still like it removed, clearing site data is sufficient and
instant.

## Changes to this policy

If the game ever gains a feature that collects data, this document will be
updated before that feature ships, and the change will be described here
explicitly. The current version has no data collection to change.

## Contact

Questions about this policy or the game:

- **Source and issue tracker:** https://github.com/revilend/Dino-trex
- Open an issue on that repository, or use the contact details published there.

---

*Pixel Dino: Parkour Run is a fan parody of the Chrome offline T-Rex runner. It is not
affiliated with, endorsed by, or associated with Google LLC or the Chrome
browser, and the Chrome dino artwork is not included — every sprite in this game
is drawn as plain rectangles by the game's own code.*
