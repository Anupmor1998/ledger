# Agent Instructions

This repository contains a production ledger system where order-related data is critical.

## Order-Related Changes

- If a requested change affects orders, order progress, commission logic, quantity/meter conversions, reopen/complete flows, carry-forward behavior, or any related client UI that writes order data, the agent must stop and ask for approval before making changes.
- Before proceeding, the agent must clearly explain:
  - what is being changed,
  - why the change is needed,
  - what existing logic may be affected,
  - what new risk or regression could be introduced.
- The agent must not silently modify order logic, calculations, or order-related database writes without explicit approval.

## High-Risk Order Areas

- `Commission logic`:
  - Any change to commission calculation, commission previews, stored commission values, or commission repair scripts requires explicit approval.
  - The agent must explain whether the change affects live display only, stored values only, or both.
- `Meter and quantity conversion`:
  - Any change to processed quantity, processed meter, unit conversion, rounding, or completion logic requires explicit approval.
  - The agent must explain how the change behaves for `TAKKA`, `LOT`, and `METER`.
- `Client-side order editing`:
  - Any change to order edit, order progress, reopen, complete, or carry-forward UI must be treated as order logic work and requires explicit approval.
  - The agent must describe whether the client and server both need updates or only one side.

## Safety Expectations

- Prefer additive changes over altering existing behavior.
- If a fix could affect already working order logic, ask first.
- If a change needs a data repair, migration, or cleanup, explain the impact and wait for approval before applying it.
- Whenever possible, add auditability or traceability for order mutations so future issues can be diagnosed safely.

## General Behavior

- Keep changes small and focused.
- Preserve existing behavior unless the user explicitly approves a change.
- When in doubt, ask before proceeding.
