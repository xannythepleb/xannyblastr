# xannyblastr

<img width="1023" height="920" alt="image" src="https://github.com/user-attachments/assets/9f47869f-b9d9-4392-9877-9acf9bfd15d8" />

**A private, DM only Nostr relay that blasts gift wrapped direct messages to a fan-out of downstream relays, restricted to an operator's web of trust.**

`xannyblastr` is a specialised [Nostr](https://github.com/nostr-protocol/nostr) relay with a narrow job: accept encrypted direct messages from a trusted set of people and rebroadcast them to many other relays, improving the odds that a DM actually reaches its recipient. It deliberately refuses to be a general purpose relay — it stores and forwards direct messages and nothing else.

It is designed for individuals or small communities who want a personal DM "outbox" (and inbox) that is spam-resistant by construction: only the operator, their web of trust, and people the operator has messaged first are allowed to publish.

## Why this exists

DMs have always been problematic on Nostr as there are a lot of relays and everyone prefers to use different ones, different clients manage relays differently, and so on. This is an attempt to solve that problem by blasting your DMs onto as many relays as possible to make sure the pleb you're trying to DM actually gets your message.

It is focused only on encrypted direct messages sent as **gift wrapped events** ([NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)) so your DMs stay private even if they sit on some random guy's relay.

A "blastr" relay addresses this by forwarding each message to a whole set of relays at once. To help mitigate the problem of spamming, `xannyblastr` gates writes behind the operator's **web of trust** and an explicit list of people the operator has already contacted, while keeping the relay itself unable to read any message content.

## Features

- **DM-only by design.** Accepts only gift wrapped DMs (kind `1059`) and DM relay lists (kind `10050`, [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)). Every other event kind is rejected.
- **Fan-out blasting.** Each accepted gift wrap is forwarded to every relay in a configurable send list.
- **Automatic relay discovery.** New downstream relays can be learned from `10050` events and added to the send list (configurable to learn from anyone trusted, or from the operator only).
- **Web-of-trust access control.** Writes are limited to the operator's key, everyone they follow, and everyone *those* people follow (depth 2). The only people outside your web of trust who can use this are people you DM first.
- **Authenticated by design.** Because gift wraps are signed by throwaway keys, access control is enforced through [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) authentication, not the event author.
- **Health tracking and self-pruning.** Every forward attempt is recorded as success or failure; unreliable *learned* relays are automatically purged on a configurable schedule.
- **Live, file-driven relay list.** The manual relay list lives in the database (so it updates without restarts) and mirrors to a human-editable `relays.yml` for easy bulk editing.
- **Self-describing.** Serves a [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document (name, description, supported NIPs) over HTTP on the same port.
- **Private reads.** By default, clients must authenticate and can only read the messages addressed to them.
- **Operator CLI.** A friendly command-line tool for editing configuration and inspecting relay health, with typed validation instead of hand-edited JSON. This actually exposes some very cool data - for example you can query the CLI for the top 10 best and worst relays according to your instance, defined by how often it's able to successfully send events to them.
- **Container ready.** Ships with a multi-stage `Dockerfile` and a `docker-compose.yml`.

## How it works

### Gift wraps and the authentication problem

A gift wrapped DM (kind `1059`) is signed by a random, single use key. The real sender is encrypted inside the wrapper, so the relay cannot tell who sent it. This is central to NIP-59's privacy guarantees — and it means a relay **cannot** decide who is allowed to write by looking at the event's signature.

`xannyblastr` therefore authenticates the *connection* rather than the event. When a client connects, the relay issues a NIP-42 challenge; the client signs it with its real key, proving its identity for that session. Authorization decisions — *is this pubkey in the web of trust? has the operator messaged it before?* — are made against that authenticated identity. The relay never needs to decrypt anything.

### Building the web of trust

On startup and on a recurring schedule, the relay fetches the operator's contact list (kind `3`) from a set of **discovery relays**, then fetches the contact lists of each followed account. The union forms a depth-2 web of trust (direct follows and follows-of-follows), cached in the database and used to authorize writes.

### Blasting and harvesting

When an authorized client publishes a gift wrap, the relay stores it, forwards it to every relay in its send list, and fans it out to any connected subscribers. When it receives a `10050` DM relay list, it can harvest the relay URLs it advertises and add them to the send list, so the network of reachable inboxes grows over time.

### Health tracking and pruning

Each forward attempt is logged as a success or failure. **Success** means the relay both connected *and* received an explicit acceptance from the downstream relay — a relay that accepts the connection but rejects the write counts as a failure. Idle learned relays are also periodically probed for reachability.

The relay no longer wipes the entire log once a week. Instead, it has been upgraded to dynamically manage the list of relays it remembers by using a basic algorithm to remove relays that have poor performance and retain ones that are good. You *can* still make it delete the logs periodically in the config, but there's no real reason to unless they get really huge after running it for 10 years or something.

You can view live data on the best relays picked up by your instance like so:

```bash
docker compose exec blastr node src/cli.js relays best
```

The default is only 10, but you can also just run `blastr node src/cli.js relays best 100` (or, if you're using Docker Compose, `docker compose exec blastr node src/cli.js relays best 100`) if you want.

Output looks like this:

```bash
┌─────────┬───────────────────────────────────────┬──────────────┬───────────┬──────────┬──────────┐
│ (index) │ relay                                 │ success rate │ successes │ failures │ attempts │
├─────────┼───────────────────────────────────────┼──────────────┼───────────┼──────────┼──────────┤
│ 0       │ 'wss://asia.vectorapp.io/nostr'       │ '100.0%'     │ 31        │ 0        │ 31       │
│ 1       │ 'wss://bucket.coracle.social'         │ '100.0%'     │ 31        │ 0        │ 31       │
│ 2       │ 'wss://fanfares.nostr1.com'           │ '100.0%'     │ 31        │ 0        │ 31       │
│ 3       │ 'wss://freelay.sovbit.host'           │ '100.0%'     │ 31        │ 0        │ 31       │
│ 4       │ 'wss://haven.downisontheup.ca/chat'   │ '100.0%'     │ 31        │ 0        │ 31       │
│ 5       │ 'wss://inbox.azzamo.net'              │ '100.0%'     │ 31        │ 0        │ 31       │
│ 6       │ 'wss://jskitty.cat/nostr'             │ '100.0%'     │ 31        │ 0        │ 31       │
│ 7       │ 'wss://nip17.com'                     │ '100.0%'     │ 31        │ 0        │ 31       │
│ 8       │ 'wss://nostr-01.yakihonne.com'        │ '100.0%'     │ 31        │ 0        │ 31       │
│ 9       │ 'wss://nostr-pub.wellorder.net'       │ '100.0%'     │ 31        │ 0        │ 31       │
│ 10      │ 'wss://nostr-relay.derekross.me/chat' │ '100.0%'     │ 31        │ 0        │ 31       │
│ 11      │ 'wss://nostr.bitcoiner.social'        │ '100.0%'     │ 31        │ 0        │ 31       │
│ 12      │ 'wss://nostr.computingcache.com'      │ '100.0%'     │ 31        │ 0        │ 31       │
│ 13      │ 'wss://nostr.data.haus'               │ '100.0%'     │ 31        │ 0        │ 31       │
│ 14      │ 'wss://nostr.oxtr.dev'                │ '100.0%'     │ 31        │ 0        │ 31       │
│ 15      │ 'wss://nostrrelay.com'                │ '100.0%'     │ 31        │ 0        │ 31       │
│ 16      │ 'wss://offchain.pub'                  │ '100.0%'     │ 31        │ 0        │ 31       │
│ 17      │ 'wss://relay.agora.social'            │ '100.0%'     │ 31        │ 0        │ 31       │
│ 18      │ 'wss://relay.coinos.io'               │ '100.0%'     │ 31        │ 0        │ 31       │
│ 19      │ 'wss://relay.fountain.fm'             │ '100.0%'     │ 31        │ 0        │ 31       │
│ 20      │ 'wss://relay.getsafebox.app'          │ '100.0%'     │ 31        │ 0        │ 31       │
| [...  skipping to the end for space             |              |           |          |          |
│ 99      │ 'wss://vitor.nostr1.com'              │ '45.2%'      │ 14        │ 17       │ 31       │
└─────────┴───────────────────────────────────────┴──────────────┴───────────┴──────────┴──────────┘

```

This data is then used by xannyblastr to decide the relays to keep sending and receiving events to and from.

### The relay list: database plus YAML

Manually managed relays are stored in the SQLite database, so the running relay reads them live and never needs a restart when the list changes. Alongside the database, a human-editable `relays.yml` holds the same list:

- On boot, `relays.yml` is reconciled into the database (additions inserted, removals dropped). Harvested relays are left untouched.
- The CLI updates both the database and `relays.yml`, taking effect immediately on a running relay.
- For bulk changes, the file can be edited by hand and applied with a single `relays sync` command — no restart required.

Supported NIPs: **1, 11, 17, 42, 59**.

## Installation

The relay listens on a single port (`7447` by default) for both WebSocket traffic and the NIP-11 HTTP document (default `7447`). It expects to run behind a TLS-terminating reverse proxy (such as [Caddy](https://caddyserver.com/) or nginx) so clients can reach it over `wss://`.

### With Docker Compose (recommended)

```bash
git clone https://github.com/xannythepleb/xannyblastr.git
cd xannyblaster

# Both files must exist before the first start, or Docker will create
# directories in their place.
cp config.example.json config.json
cp relays.example.yml relays.yml

# Generate a key for the relay to authenticate to downstream relays:
docker compose run --rm blastr npm run genkey

# Edit config.json (at minimum: adminNpub, relaySecretKey, relayUrl).
docker compose up -d --build
docker compose logs -f blastr
```

### Manually (Node.js)

```bash
git clone https://github.com/xannythepleb/xannyblastr.git
cd xannyblaster

npm install
cp config.example.json config.json
cp relays.example.yml relays.yml
npm run genkey            # prints an nsec/npub for the relay's own identity
# edit config.json
npm start
```

## Configuration

Runtime settings live in `config.json` (copied from `config.example.json`). The manually managed blast relays live separately in `relays.yml`.

| Field | Description |
| --- | --- |
| `name`, `description` | Human-readable identity advertised to clients via NIP-11. |
| `adminNpub` | The operator's identity, as an `npub` or 64-character hex pubkey. This key and its web of trust may write. |
| `relaySecretKey` | The relay's own key (`nsec` or hex), used to authenticate to downstream relays that require NIP-42. Generate with `npm run genkey`. The derived `npub` is printed in the startup logs and shown by `blastr status`. |
| `relayUrl` | The public `wss://` URL of this relay. Validated during NIP-42 authentication, so it must match what clients connect to. |
| `relaysFile` | Path to the manual relay list (default `./relays.yml`). |
| `discoveryRelays` | Relays queried to read contact lists when building the web of trust. |
| `wotDepth` | Web-of-trust depth: `2` includes follows and follows-of-follows. |
| `wotRefreshHours` | How often the web of trust is rebuilt. |
| `maxWotSize`, `wotFetchConcurrency` | Bounds for the depth-2 crawl. |
| `harvest10050From` | `"all"` to learn relays from any authorized writer's `10050`, or `"admin"` to learn only from the operator's. |
| `livenessIntervalHours` | How often idle learned relays are probed for reachability. |
| `outboundConnectConcurrency` | Maximum number of simultaneous outbound WebSocket connections to downstream and discovery relays. |
| `outboundConnectIntervalMs` | Minimum delay, in milliseconds, between starting outbound relay connections globally. |
| `outboundConnectPerRelayIntervalMs` | Minimum delay, in milliseconds, before starting another outbound connection to the same relay. |
| `logRetention` | How long the health log lives before pruning and wiping. Default `"7d"`. Accepts values like `"12h"`, `"1w"`, `"30m"`, or a bare number (interpreted as days). |
| `privateReads` | When `true`, clients must authenticate to read and only receive the messages addressed to them. |
| `host`, `port` | Bind address and port. |
| `dataDir` | Directory for the SQLite database. |

### The relay list (`relays.yml`)

```yaml
relays:
  - wss://relay.damus.io
  - wss://nos.lol
  - wss://relay.primal.net
```

This file is the source of truth for *manual* relays. Harvested (auto discovered) relays are managed automatically and never appear here.

## Usage

The CLI handles configuration edits and health inspection. Run it directly with Node, via the `npm run cli` script, or inside the container with `docker compose exec blastr node src/cli.js`.

Command reference:

```bash
blastr — admin CLI

Manual blast relays (stored in the DB + relays.yml; changes apply live, no restart):
  blastr relays add <url>                  add a relay (updates DB and relays.yml)
  blastr relays remove <url>               remove a relay (updates DB and relays.yml)
  blastr relays sync                       apply bulk edits made to relays.yml
  blastr relays list                       all known relays (manual + learned)
  blastr relays recent [n]                 most recently used + last result
  blastr relays best  [n]                  highest success rate
  blastr relays worst [n]                  lowest success rate
  blastr relays rate                       success rate for every relay
  blastr relays refresh [n]                run discovery + probe now, then show best [n] (default 5)

Config (config.json settings; validated; restart relay to apply):
  blastr config set <key> <value>          e.g. config set logRetention 14d
                                                config set name My DM Relay
                                                config set privateReads false
  blastr config add discovery <url>        add a WoT discovery relay
  blastr config remove discovery <url>     remove a WoT discovery relay
  blastr config get <key>                  show one value
  blastr config list                       show all values (secret key masked)
  blastr config keys                       list editable settings + types
  blastr config validate                   check the whole config is valid
  blastr config set-raw <key> <json>       escape hatch for raw JSON

  (config add relay <url> also works and is an alias for "relays add")

Status:
  blastr status                            summary incl. next log wipe
  blastr next-wipe                         time until the log is wiped

```

For Docker Compose, simply add `docker compose exec blastr node src/cli.js` to the beginning of any command.

For example:

```bash
docker compose exec blastr node src/cli.js blastr relays add
```

Yeah it's a lot just to run a command. Sorry. Working on making that more user friendly.

### Managing blast relays

These changes are written to both the database and `relays.yml` and take effect on a running relay immediately — no restart.

Get some cool data on the best and worst relays and the success rate for each one.

```bash
blastr relays add wss://relay.example.com      # add a relay
blastr relays remove wss://relay.example.com   # remove a relay
blastr relays sync                             # apply bulk hand-edits to relays.yml
blastr relays list                             # all known relays (manual + learned)
blastr relays recent [n]                       # most recently used, with last result
blastr relays best [n]                         # highest success rate
blastr relays worst [n]                        # lowest success rate
blastr relays rate                             # success rate for every relay
```

You can also bulk add relays by adding them to `config.yml` then running `blastr relays sync`.

### Editing configuration

Settings are validated against a schema, so a malformed value or bad URL is rejected with a clear message rather than corrupting the file. Restart the relay for `config` changes to take effect.

```bash
blastr config set logRetention 14d
blastr config set name My DM Relay         # no quoting needed for spaces
blastr config set privateReads false
blastr config set outboundConnectConcurrency 4
blastr config set outboundConnectIntervalMs 250
blastr config set outboundConnectPerRelayIntervalMs 1000
blastr config add discovery wss://purplepag.es
blastr config get adminNpub
blastr config list                         # secret key is masked
blastr config keys                         # list every editable setting + type
blastr config validate                     # check the whole config is valid
```

Values are coerced to the correct type automatically: `8080` becomes a number, `false`/`yes`/`on` become booleans, durations like `14d` are validated, and URLs are normalised and de-duplicated. The outbound connection limits are shared by blasting, relay discovery, and liveness probes.

### Status

```bash
blastr status        # summary, including blastr npub, outbound relay limits, and time until the next log wipe
blastr next-wipe     # time remaining before the health log is wiped
```

### Client requirements

Any client used to send or read DMs through this relay must support **NIP-42 authentication**. Most modern Nostr clients do. Without it, the relay will refuse writes (and reads, when private reads are enabled).

## Access control & security model

- **Only the connection's authenticated key is trusted.** Authorization is based on the NIP-42-authenticated pubkey, never on a gift wrap's (ephemeral) signature.
- **Who may write:** the operator; anyone in the depth-2 web of trust; and anyone the operator has messaged first. Contacted-but-untrusted users may only send replies addressed back to the operator.
- **The relay cannot read messages.** It stores and forwards opaque encrypted blobs; it never decrypts content.
- **Private reads** (default) prevent clients from harvesting other people's messages — a reader only receives gift wraps addressed to their authenticated key.
- **Relay growth is bounded by trust.** Harvesting new downstream relays is gated by the same write check, so the send list can only be expanded by already-trusted participants (or locked to the operator entirely).

This is independent software and has not been formally audited. Operators should review the code and run it behind appropriate transport security before relying on it.

## Project structure

```
Dockerfile, docker-compose.yml      Container build and orchestration
config.example.json                 Template for config.json
relays.example.yml                  Template for relays.yml
src/
  index.js          Entry point; reconciles relays.yml into the database on boot
  config.js         Config loading, validation, and duration parsing
  db.js             SQLite storage and statistics
  relays-store.js   relays.yml <-> database synchronisation
  nostr.js          Event verification, NIP-42 validation, tag helpers
  nip11.js          NIP-11 relay information document
  relay-client.js   Outbound client: publish, fetch, and probe downstream relays
  relay-server.js   The relay server (HTTP/NIP-11, WebSocket, NIP-01, NIP-42)
  access-control.js Authorization decisions
  wot.js            Web-of-trust construction
  blaster.js        Message fan-out and relay harvesting
  relay-health.js   Liveness probes and scheduled pruning
  scheduler.js      Periodic jobs (WoT refresh, liveness, retention)
  cli.js            Operator command-line interface
```

## Tech stack

- **Runtime:** [Node.js](https://nodejs.org/) (>= 18), ES modules.
- **Networking:** [`ws`](https://github.com/websockets/ws) for the WebSocket relay server and for outbound connections to downstream relays; Node's built in HTTP server for the NIP-11 document.
- **Storage:** [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (SQLite in WAL mode) for events, the relay list, the web-of-trust cache, and the health log.
- **Nostr primitives:** [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) for signature verification, NIP-19 (npub/nsec) encoding, and NIP-42 helpers.
- **Config files:** [`js-yaml`](https://github.com/nodeca/js-yaml) for the human-editable relay list.
- **Packaging:** Docker (multi-stage build) and Docker Compose.

## Limitations & caveats

- **Web-of-trust size.** A depth-2 web of trust can contain tens of thousands of keys for a well connected account. The crawl is concurrency limited and capped by `maxWotSize`, but the first refresh can be slow and places load on the discovery relays.
- **Global send list, not per-recipient routing.** A strict NIP-17 implementation would deliver each message to the *recipient's* declared inbox relays. This project uses a single global send list to blast the DMs across many relays. Relays discovered by kind `10050` events are used to expand the known relays, and are retained as long as they are successfully able to be used.
- **No formal security audit.** This was mostly vibe coded while I was listening to Eminem on a Saturday afternoon. After Claude wrote the bulk of it, I did get ChatGPT to tighten up the security. That counts as an audit, right? Of course, as this exists purely to handle encrypted notes and rejects everything else, there's nothing of value for a potential attacker to steal anyway.

## Roadmap

* PoW support alongside the WoT for determining who can send you DMs.
* A cool web dashboard that displays a ranked list of relays within your instance's database.
* Built in Tor support for increased censorship resistance and privacy.
* Add option to auto exclude paid relays (since this auths as its own npub, not yours).
* Instead of perma-deleting the log, keep a separate one of relays that are below say 20% reliability that is permanent so the blastr stops trying to connect to them forever.
