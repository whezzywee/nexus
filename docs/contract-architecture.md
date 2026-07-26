# Contract architecture

## Design rules

Nexus state is sharded by community, channel, conversation, time/activity
window, and artifact. No single contract owns the whole product.

All growable collections use map/set semantics keyed by stable IDs. Updates are
idempotent operations. Deletion is a signed tombstone. Per-key conflicts use a
documented total order. Every full-state and delta path is validated, merged,
deduplicated, and deterministically bounded.

State, summaries, and deltas serialize deterministically. Rust uses
`BTreeMap`/`BTreeSet` or sorted vectors in all byte-compared structures.

## Contracts

### Community

One parameterized contract per community:

- stable metadata and owner;
- member add/remove operations;
- role definitions and assignments;
- channel-directory shard references;
- invitation rules and moderation policy;
- schema and migration pointer.

Member removal wins an equal-sequence add/remove tie. Role grants cannot exceed
the actor's effective grant authority.

### Channel index

One or more directory shards per community:

- channel records keyed by channel ID;
- category and deterministic rank;
- permission overwrites;
- active and historical segment references.

Reordering uses fractional rank tokens with `(rank, channel_id)` as the total
order. It never replaces the full channel array.

### Message segment

One contract per bounded segment. The state is a map from `message_id` to the
winning signed message version and a reaction set keyed by
`(message_id, emoji, actor_id)`.

Each message carries:

```text
message_id, channel_id, author_id, author_device_id
created_at, client_generated_order, content, reply_to
attachment_references, signature, encryption_metadata
edit_version, deletion_tombstone
```

Conflict order for the same message ID:

1. valid author signature and matching author;
2. greater `edit_version`;
3. deletion wins an equal-version tie;
4. lexicographically greater signed operation ID as the final deterministic tie.

New segments are created at 512 messages or 4 MiB encoded target size. A segment
hard-rejects state above 8 MiB. Closed segments accept only bounded reactions,
edit/tombstone operations during the configured application window; later
compaction creates a successor summary rather than mutating history forever.

### Direct message

Conversation metadata and encrypted operation segments are separate. State
contains membership epochs, public device keys, opaque ciphertext, and
per-conversation encryption metadata. It never contains plaintext.

The initial cipher provider uses one random conversation key per epoch. The key
is encrypted independently to each authorized device public key. Removing a
member creates a new epoch and key; it cannot revoke ciphertext already
received. The `GroupCipher` interface keeps MLS replacement possible.

Conversation control is materialized separately from the immutable bootstrap
creator. A signed controller-transfer operation names an already-authorized
successor device at the current epoch. Subsequent rotations must be signed by
the materialized controller and retain at least one of that controller's
devices. This lets community ownership move without leaving private-key
rotation permanently attached to the founder.

### Presence

Presence is an observed-remove map keyed by device. Each record carries a
monotonic device sequence, signed expiry, state, last-active hint, and voice
room. Clients ignore expired records. Contract pruning uses deterministic
sequence/window bounds rather than local time.

### Voice session

The voice contract stores bounded, recipient-encrypted signaling envelopes.
Every envelope includes sender, recipient, call ID, sequence, expiry, type, and
ciphertext. Clients reject expired or replayed messages. Media never traverses
Freenet.

### Release manifest

The release state contains signed immutable release records, revocations,
one-hop Core compatibility-pin transitions, chunk hashes and offsets, minimum
compatible version, and rollback metadata. A release is accepted only after
developer-signature verification. A build accepts a different Core
compatibility value only when the offline trust root signed a transition from
the build's current pin to that exact release and next pin. Clients never
execute an artifact until each chunk and the assembled file verify.

## Merge algebra

For a state `S` and operation sets `A` and `B`:

```text
merge(S, A ∪ B) = merge(S, B ∪ A)
merge(merge(S, A), B) = merge(S, A ∪ B)
merge(S, A ∪ A) = merge(S, A)
```

Tests permute operations, duplicate them, split them across replicas, exchange
summary/delta pairs, and assert byte-identical final state.

## Schema evolution

Wasm changes rotate code hashes and may rotate parameterized contract keys.
Additive fields use defaults and preserve byte compatibility of signed records.
Breaking shapes require a V2 contract and explicit proof-carrying migration.
Clients retain old code hashes long enough to read and merge state into the new
contract.
