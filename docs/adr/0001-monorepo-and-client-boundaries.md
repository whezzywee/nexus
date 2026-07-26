# ADR 0001: Monorepo with separate client presentations

Status: accepted

## Decision

Use pnpm and Cargo workspaces. Desktop and web import shared domain packages but
own independent React trees, routing, navigation, responsive rules, and complex
components.

## Consequences

Protocol and security fixes land once. Desktop and web can still optimize for
different input modes, screen sizes, native capabilities, and performance
budgets. Visual drift is controlled with shared branding primitives, not a
forced universal layout library.
