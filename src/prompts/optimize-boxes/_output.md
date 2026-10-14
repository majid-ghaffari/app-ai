Output: one JSON object of this shape.

```json
{
  "headline": "Your product pages now offer something to buy with the product",
  "summary": "The Merchandising Agent added a Frequently Bought Together box above Related Items on your product pages, and moved Featured: Denim above Featured: Hoodies on your home page because shoppers click it more. Both changes wait in your draft.",
  "pages": [
    {
      "page": "Product",
      "why": "Shoppers saw similar products but nothing that goes with the one they were looking at, so a bought-together box now sits above Related Items."
    },
    {
      "page": "Home",
      "why": "Featured: Denim gets more clicks than Featured: Hoodies, so it now comes first."
    },
    {
      "page": "Collection",
      "why": "The Merchandising Agent found its boxes already fit the page, so they stay as they are."
    }
  ],
  "basedOn": "Based on screenshots of your pages and your box views and clicks in the last <days> days, with the Merchandising Agent"
}
```

Rules:
1. `pages` holds every page the data gives, once each, in the data's order, with its `page` echoed exactly, and every page has its `why`.
2. Describe only the changes the data shows: an `after` box marked `added` or `moved`, or a `before` box missing from `after`. Never suggest another change; the owner asks the Merchandising Agent for one in its own chat.
3. A page carries only `page` and `why`: no change list, no box keys and no positions.
4. `question` is present only when you ask one.
