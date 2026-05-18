---
"ton-better-auth": minor
---

Add major TON Connect plugin enhancements across server, client, and React DX:

- add `set-primary` and `switch-session-wallet` authenticated endpoints for explicit primary-wallet and active-session wallet control
- upgrade domain allow-listing with wildcard support and per-network domain policies
- add configurable anti-abuse controls (per-IP/per-address limits, failed-verify cooldown, optional captcha hooks)
- add configurable multi-wallet auth rules (`onlyPrimaryCanSignIn`, `allowOnlyLinkedWallets`, `autoLinkOnVerify`)
- add lifecycle event hooks (`onChallengeIssued`, `onVerifySuccess`, `onVerifyFail`, `onWalletLinked`)
- add `ton-better-auth/react` with `useTonConnectAuth` for challenge refresh + verify lifecycle + typed auth errors
