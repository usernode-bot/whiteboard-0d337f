# Home-screen icon

`icon.png` is this app's tile on the Homeroom home screen, declared in
`dapp.json` as `"icon": { "image": "brand/icon.png" }`. The platform reads it at deploy time; the app never serves
it, which is why it lives outside `public/`.

It follows the shared Homeroom tile icon style (v1), so it sits with the
other apps' icons as one set:

- Glyph: Lucide `presentation` (white, 2px round strokes on the 24-unit grid),
  centred in the middle 288 px of the tile, with a soft drop shadow.
- Colour: teal, a diagonal gradient `#34D3C3` → `#0B7D84` (top left to
  bottom right) under a faint top-left highlight.
- 512 × 512 PNG, full bleed, no text, no transparency. The platform rounds
  and crops the tile itself.

To change the icon, replace `icon.png` with a new render in the same style
and update this note. The change applies once the proposal is voted in and
deployed.
