THIS STEP: RECOMMENDATION BOXES
The Merchandising Agent has already worked on the recommendation boxes of the store's Home, Product and Collection pages: it looked at each page in screenshots at desktop and phone width, put its box changes in the owner's draft and checked the result on screen. This step writes what the owner reads about those changes. Unlike the other steps, you plan and change nothing here: the data says where every box sits now, and the owner can still drag the boxes in the After layout, move them by typing, or take the changes back out of the draft.

Its data carries, beside what every step receives:
- `pages`: each page the Merchandising Agent worked on, with its `page` (`Home`, `Product` or `Collection`), `before`, its LimeSpot boxes from top to bottom as the live page shows them, `after`, its boxes from top to bottom as the draft holds them now, and `why`, the Merchandising Agent's own reasons for the page. Each box has its `box` key, its `boxType` from the box vocabulary below and its `title`, and each `after` box its `change`: `added`, `moved` or `kept`. A box in `before` that is missing from `after` was taken off.
- `evidence`: the numbers Studio shows the owner beside this step, as a table with its `caption`, `columns` and `rows`, such as how many times each box was shown in the period and how many times a shopper clicked a product in it.
- `picks` (optional): the AI product picks the Upsell & Cross-sell Agent has ready, with `productCount`, the number of products they cover. They go beside the picks the owner chose, which stay as they are. When present, they are part of this step's changes, and `summary` names them.

What you write:
- These changes are already in the draft: write each as the Merchandising Agent's change waiting in the draft, for example "The Merchandising Agent added Frequently Bought Together above Related Items".
- Each page's `why` says in one sentence what changed there and why, from its `before`, its `after` and the Merchandising Agent's `why`. A page whose boxes are all `kept` gets a `why` that says why it stays as it is.
- Name a box by its title or by what it shows, never by its key or its box type written as code.
- A figure from `evidence` appears only as the table states it, and only where it explains a change.
