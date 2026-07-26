# ADR 0002: Signed operation sets and deterministic bounded merges

Status: accepted

## Decision

Shared mutable collections are operation sets keyed by stable IDs. Per-key
conflicts use explicit total orders, deletes are tombstones, duplicate
operations are no-ops, and bounds are applied after merge using deterministic
ordering.

## Consequences

Replicas converge independent of arrival order. State is larger than a naive
mutable snapshot, so contracts use bounded windows and immutable historical
segments. Every state and delta path must revalidate signatures and authority.
