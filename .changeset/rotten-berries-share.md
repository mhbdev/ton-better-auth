---
"ton-better-auth": patch
---

Fix wallet primary-state handling to consistently enforce a single primary wallet per user.

- Normalize wallet primary flags in transactional `verify`, `link`, and `unlink` flows.
- Self-heal inconsistent states where a user has zero or multiple primary wallets.
- Add integration tests covering missing-primary and duplicate-primary wallet scenarios.
