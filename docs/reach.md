# nandaindex.org/reach

**A Personal Agent Protocol (Poppy) extension for reaching a person's agent later, through the NANDA Index.**

Version 1 · Draft of 2026-11-15 · Status: proposal, with a running reference implementation

- Reference implementation and demo: <https://github.com/Sharathvc23/nanda-reach-demo>
- Slides, IETF 127 Hackathon: [ietfdawn2026.pdf](https://github.com/Sharathvc23/nanda-reach-demo/blob/main/docs/ietfdawn2026.pdf)
- Live: John's agent <https://mymuse.stellarminds.ai> · the company <https://travel26-production.up.railway.app>

---

## 1. Purpose

Poppy 1.0 lets a Personal Agent find a Company through `/.well-known/poppy.json`, open a pseudonymous session and use the Company's APIs. It has no way for the Company to contact the Personal Agent after the session is over. Push notifications are on Poppy's roadmap, not in the specification.

This extension gives the Company one durable thing to keep: the person's **NANDA locator**, a stable identifier that starts from a verified email and is resolved in the NANDA Index. Everything that can change later, which agent the person uses, where the agent card lives, which inbox a topic goes to, is looked up at send time. The Company never stores an inbox address, an endpoint or a card URL.

The resolution chain:

```
locator → Index entry → agent card → routing rule → inbox
```

The locator is the only link held by the Company. Every hop after it is controlled by the person.

## 2. Terms

| Term | Meaning |
|---|---|
| Company | The site a Personal Agent acts on, as in Poppy. Publishes `/.well-known/poppy.json`. |
| Personal Agent | The agent acting for the person, as in Poppy. Has a `client_id` URL and a client metadata document. |
| NANDA locator | A URN of the form `urn:air:<publisher>:personal:<email>`, registered in the NANDA Index by the person. Example: `urn:air:host39.org:personal:john@example.com`. |
| NANDA Index | The resolution service. `GET /api/v1/resolve?locator=<locator>` returns the entry, which names the current agent card URL. Reference deployment: `https://api.nandaindex.org`. |
| Agent card | An A2A-shaped JSON document the person hosts at a URL of their choice. For this extension it carries two additional fields, `agents` and `routing` (section 6). |
| Topic | A short label the Company attaches to a message, such as `travel` or `promotion`. The card routes by topic. |

The key words MUST, MUST NOT, SHOULD and MAY are to be read as in BCP 14.

## 3. Company declaration in poppy.json

A Company that supports the extension lists it under `extensions` in its `poppy.json`:

```json
"extensions": {
  "nandaindex.org/reach": [
    {
      "version": "1",
      "index": "https://api.nandaindex.org",
      "message_topics": ["travel", "promotion"],
      "sender": "travel26desk@inkboxmail.com",
      "endpoint": "https://travel26.example/poppy/reach",
      "description": "What the Company keeps and how it reaches you."
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `"1"`. |
| `index` | yes | Base URL of the NANDA Index the Company resolves against. |
| `message_topics` | yes | Topics the Company may send. A person can route or decline each one on their card. |
| `sender` | yes | The address messages will come from, so the person can recognise and filter them. |
| `endpoint` | no | A URL that documents the Company's use of the extension in human- and machine-readable form. |
| `description` | no | One sentence for the person. |

## 4. Personal Agent opt-in

The Personal Agent opts in per session by sending the Poppy extensions header on its requests:

```
Poppy-Extensions: "nandaindex.org/reach";v="1"
```

and by publishing the locator in its **client metadata document** (the document at its `client_id` URL, which the Company already fetches to verify the Poppy-Session JWT):

```json
{
  "client_id": "https://agent.example/poppy/client.json",
  "client_name": "mymuse",
  "jwks_uri": "https://agent.example/poppy/jwks.json",
  "nanda_locator": "urn:air:host39.org:personal:john@example.com",
  "nanda_card": "https://agent.example/.well-known/agent-card.json"
}
```

| Field | Required | Meaning |
|---|---|---|
| `nanda_locator` | yes | The person's NANDA locator. |
| `nanda_card` | no | Where the card lives today. Informational only. The Company MUST NOT use it to reach the person; it MUST resolve the locator instead (section 5). |

The Company reads `nanda_locator` only when the header is present with a matching version. A request without the header is an ordinary Poppy request and nothing is stored.

Because the metadata document is fetched over HTTPS from the `client_id` origin and the session JWT is verified against the keys that document names, the locator arrives bound to the same identity as the session.

### 4.1 Alternative: a tool call

A Company that exposes an MCP API MAY also offer a tool for agents that do not implement the header:

```
share_nanda_locator({ nanda_locator: "urn:air:…" })
```

The effect is identical to the header path. The reference implementation offers both.

## 5. What the Company stores, and how it reaches the person

The Company stores, per known agent: the Poppy `client_id`, the pseudonymous user id (`sub`) and the `nanda_locator`.

The Company MUST NOT store, for the purpose of contacting the person later: the agent card, any inbox address, any endpoint URL, or the card URL returned by the Index. It MAY cache a resolution for a short time within one send.

To send a message with topics T the Company:

1. Resolves the locator: `GET <index>/api/v1/resolve?locator=<locator>`.
2. Takes the entry's `registry_url` (or `url`) as the card URL and checks the entry's status is `active`.
3. Fetches the card and checks it has `agents` and `routing`.
4. Walks `routing` in order and takes the first rule whose `match` is in T or is `"*"`.
5. If the rule's `deliver_to` is `"none"`, the person declines this topic: the Company MUST NOT send, and SHOULD record the hold as the person's choice rather than an error.
6. Otherwise delivers to the inbox of the agent whose `id` equals `deliver_to`, by that inbox's `kind`.

Because step 1 runs on every send, the person can change agents, re-point their Index entry, move their card to a new URL or decline a topic, and the next send follows the new card with no action on the Company's side. A Company that saved the card URL at first contact instead would receive `410 Gone` after a move and lose the person; the reference demo shows both side by side.

## 6. Agent card fields

The card is an A2A agent card (so Index card checks and generic A2A clients accept it) with two added fields:

```json
"agents": [
  { "id": "muse", "name": "John on Muse", "harness": "muse",
    "inbox": { "kind": "inkbox", "address": "johnmuse@inkboxmail.com" } },
  { "id": "wajo", "name": "John on Wajo", "harness": "wajo",
    "inbox": { "kind": "inkbox", "address": "john@inkboxmail.com" } }
],
"routing": [
  { "match": "travel",    "deliver_to": "wajo" },
  { "match": "promotion", "deliver_to": "none" },
  { "match": "*",         "deliver_to": "muse" }
],
"version": "2"
```

| Field | Meaning |
|---|---|
| `agents[].id` | Stable id referenced by `routing`. |
| `agents[].inbox.kind` | Delivery mechanism. This version defines `inkbox` (an InkBox mailbox address). Other kinds may be added. |
| `agents[].inbox.address` | The address for that kind. |
| `routing[].match` | A topic, or `"*"` for everything else. First match wins. |
| `routing[].deliver_to` | An agent id on the card, or `"none"`: the person declines the topic. |
| `version` | Incremented on every change, so a sender can log which version it followed. |

## 7. Security and privacy considerations

- The locator is derived from an email address. A Personal Agent SHOULD share it only with Companies the person has chosen to deal with, and only when the person has agreed to be contacted later. The opt-in is per session, not per agent.
- The Company learns nothing about where the person's agents are until it sends, and nothing it learns at send time is kept. Changing agents, hosts or preferences does not require telling any Company.
- The Index entry is controlled by the person's Index account. Integrity of the card itself (that the document fetched is the one the person published) is out of scope for this version and is the subject of separate work.
- Declining a topic is expressed on the card, where the person can see and change it, rather than in per-Company settings.
- A Company MUST honour `"none"` and MUST NOT fall back to a cached inbox or card URL when resolution fails.

## 8. Relation to other work

- **Poppy 1.0** (personalagentprotocol.org): session, client metadata, `Poppy-Extensions`. This extension adds two metadata fields and one poppy.json entry; it changes nothing in the session mechanics.
- **A2A agent cards**: the card remains a valid A2A card; `agents` and `routing` are additive.
- **NANDA Index** (nandaindex.org/paper.pdf): the locator is the stable resource identifier, the Index the resolution layer, the card the discovery entry point.
- **IETF DAWN**: DNS-AID anchors discovery in a DNS zone the subject owns; mDNS in the local link. A NANDA locator anchors a personal agent in a verified email, for people who have no domain of their own. The approaches compose: an enterprise anchors in DNS, a person in the Index, and a card can carry both. See draft-raskar-agentic-web-federated-resolution.

## 9. Reference implementation

| Piece | Where |
|---|---|
| Company side: poppy.json, `/poppy/reach`, MCP tools, the send-time chain | `src/travel26/app.ts`, `src/travel26/resolver.ts` |
| Personal Agent side: client metadata, header, card editing | `src/mymuse/poppy-client.ts`, `src/mymuse/card.ts` |
| Card schema and routing | `src/shared/card.ts` |
| Poppy session verification | `src/shared/poppy.ts` |
| Live company declaration | `https://travel26-production.up.railway.app/.well-known/poppy.json` |
| Live agent card | `https://mymuse.stellarminds.ai/.well-known/agent-card.json` |

Feedback: open an issue on the repository, or reply on the DAWN list.
