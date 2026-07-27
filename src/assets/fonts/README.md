# Bundled font faces

Regenerate with `node scripts/fetch-fonts.mjs`. That script's header explains
why these exist at all; the short version is that the picker's system-font
stacks collapsed to a single face on Android, so eight of the choices were the
same font.

Latin subset, variable weight (one file covers 400 through 800) except Anton,
which is single weight by design. Every one is **SIL Open Font License 1.1**,
which permits bundling and redistribution inside an application.

| File | Family | Used by | Foundry / author |
|---|---|---|---|
| `nunito.woff2` | Nunito | Rounded | Vernon Adams, Cyreal, Jacques Le Bailly |
| `inter.woff2` | Inter | Grotesque | Rasmus Andersson |
| `jost.woff2` | Jost\* | Geometric | Owen Earl / indestructible type\* |
| `archivo-narrow.woff2` | Archivo Narrow | Condensed | Omnibus Type |
| `atkinson.woff2` | Atkinson Hyperlegible Next | Legible | Braille Institute of America |
| `bitter.woff2` | Bitter | Slab | Sol Matas, Huerta Tipográfica |
| `caveat.woff2` | Caveat | Marker | Pablo Impallari, Impallari Type |
| `anton.woff2` | Anton | Poster | Vernon Adams, Cyreal |

Atkinson Hyperlegible was commissioned by the Braille Institute specifically to
be legible to low vision readers: letterforms are disambiguated so I/l/1 and
O/0 cannot be confused. That is the one on this list with a job beyond taste,
and it is the reason the "Legible" choice is worth its bytes on a phone held at
arm's length in direct sun.

**System**, **Serif** and **Typewriter** ship no file. `system-ui`, `serif` and
`monospace` are guaranteed to exist on every device and to differ from each
other, so those three choices already work everywhere for free.
