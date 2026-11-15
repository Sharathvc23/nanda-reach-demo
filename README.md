# nanda-reach-demo

**A merchant discovers a person's agent through the NANDA Index, keeps only the locator, and still
reaches the right agent after the person changes their agent card.**

The story has three acts. John's personal agent runs on Muse. Travel26 is a merchant with a
`poppy.json` manifest.

1. **Discovery.** John's Muse agent reads `poppy.json` and asks Travel26 for inventory, identifying
   itself by its NANDA locator. Travel26 answers and stores one thing: the locator. Not the card,
   not an inbox address, not an endpoint.
2. **Later contact.** Travel26 sends a promotion. It resolves the locator in the NANDA Index, follows
   the entry to John's card, applies the card's routing rules to the message topic (`travel`), and
   sends to the inbox the rule picks. With card v1 that is John's Muse mailbox.
3. **The update.** John adds a second agent on Wajo and a rule: travel goes to Wajo. He publishes
   card v2. Travel26 is not told. The next promotion resolves the same locator, gets the new card,
   and lands in Wajo. Muse gets nothing.

## Who does what

| Piece                  | Role                          | In this demo                                                     |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------- |
| NANDA Index            | Discovery: locator → entry    | The live index at `api.nandaindex.org`                           |
| John's agent card      | Resolution: entry → inboxes   | Hosted here at `/cards/john`, A2A-shaped, with `agents` and `routing` |
| InkBox                 | Delivery: the mailboxes       | The live service at `inkbox.ai`; three mailboxes                 |
| Travel26 / poppy.json  | The merchant                  | Hosted here: `/poppy.json`, `/travel26/*`                        |
| Console                | What the audience sees        | `/` : Travel26's store, John's card, both inboxes, the act buttons |

John's locator is `urn:air:host39.org:personal:<his first InkBox address>`. It never changes. His
Index entry's `registry_url` points at the card this service hosts, so John can add inboxes and
rules without touching the Index or any merchant.

The card's routing rule is deliberately simple: the first rule whose `match` is in the message's
topics, or `*`, wins. Travel26 tags its promotions `travel`.

## Run it

Requirements: Node 22.

```bash
npm install
npm test                     # the three acts, end to end, against in-process stand-ins
npm run dev -- --mock        # local console at http://localhost:8095 against the stand-ins
```

Live mode is the default and needs the environment in `.env.example`. `scripts/setup-live.ts`
creates everything, one command per step, keeping its progress in `data/live-setup.json`:

```bash
npx tsx scripts/setup-live.ts signup muse --human-email <throwaway@yourdomain>
npx tsx scripts/setup-live.ts verify muse --code <six digits from that inbox>
npx tsx scripts/setup-live.ts signup wajo --human-email <throwaway2@yourdomain>
npx tsx scripts/setup-live.ts verify wajo --code <...>
npx tsx scripts/setup-live.ts signup travel26 --human-email <throwaway3@yourdomain>
npx tsx scripts/setup-live.ts verify travel26 --code <...>
npx tsx scripts/setup-live.ts index-register --card-url https://<host>/cards/john
npx tsx scripts/setup-live.ts env --public-base-url https://<host>
```

`index-register` creates John's NANDA account under his Muse mailbox address, reads the two
verification emails from that mailbox over the InkBox API, and registers the entry pointing at
the card. The only human steps are the three six-digit InkBox codes. The script never prints a
key, password or token.

## Deploy

One container, one optional volume. `railway.json` builds the `Dockerfile` and watches `/health`.
Set the variables from `.env.live` on the service, with `PUBLIC_BASE_URL` the service's public URL
and `DATA_DIR=/data` on a mounted volume if state should survive redeploys.

## Endpoints

| Method | Path                           | What                                                        |
| ------ | ------------------------------ | ----------------------------------------------------------- |
| GET    | `/poppy.json`                  | Travel26's manifest, including its contact policy           |
| POST   | `/travel26/inventory`          | `{ locator, query? }` → inventory; stores the locator       |
| GET    | `/travel26/known-agents`       | What Travel26 stores                                        |
| POST   | `/travel26/promo`              | admin: resolve, route and send to every known locator       |
| GET    | `/travel26/promo-log`          | Deliveries with the full resolution trace                   |
| GET    | `/cards/john`                  | John's card (also `/cards/john/.well-known/agent-card.json`) |
| PUT    | `/cards/john/version`          | admin: `{ version: 1 \| 2 }`                                |
| POST   | `/demo/act1`                   | admin: plays John's Muse agent shopping at Travel26         |
| GET    | `/demo/resolve?topics=travel`  | Dry run of the resolution chain                             |
| GET    | `/demo/inbox/muse`, `/wajo`    | John's inboxes, read live from InkBox                       |
| POST   | `/demo/reset`                  | admin: card v1, Travel26 forgets everyone                   |

Admin endpoints take `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN` is set.
