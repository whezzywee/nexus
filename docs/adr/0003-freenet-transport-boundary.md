# ADR 0003: Freenet behind an application transport

Status: accepted

## Decision

Shared services depend on `ContractTransport`, not directly on the Freenet SDK.
Implementations are local-node, constrained-gateway, and in-memory simulation.

## Consequences

The project can adapt to Freenet API evolution and test merge/offline behavior
without a node. Simulation is explicitly unavailable in production builds and
cannot be presented as proof of Freenet interoperability.
