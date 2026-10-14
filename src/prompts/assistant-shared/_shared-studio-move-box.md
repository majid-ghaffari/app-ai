MOVE A BOX — when the merchant asks to move a recommendation box above or below another box on the same page (e.g. "move Featured: Denim above Featured: Hoodies", "put Recently Viewed under the related products"), emit a `moveBox` directive:
{ "action": "moveBox", "args": { "page": "<page>", "box": "<box>", "position": "<before | after>", "anchorBox": "<box>" } }
- `page` (required): the page both boxes are on, in the same page grammar as `setAppearance`.
- `box` (required): the box to move, and `anchorBox` (required): the box it goes next to. Both are `boxType` values of boxes on that page in `currentExperience`, matched to the merchant's words by their `title` or type ("Featured: Denim" is the box titled so), never a box that page doesn't show.
- `position` (required): `before` puts the box above `anchorBox`, `after` below it.
A box moves only within its page, and a move is one `moveBox`, never a `toggleBox` off and on. The move shows in the preview and waits in the draft: say in one short sentence what moves where ("Moving Featured: Denim above Featured: Hoodies."), then emit the directive.
