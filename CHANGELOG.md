# ton-better-auth

## 0.1.3

### Patch Changes

- [`60cedd1`](https://github.com/mhbdev/ton-better-auth/commit/60cedd18bc8677fc9a44c1053ec2285c57ae98c8) Thanks [@mhbdev](https://github.com/mhbdev)! - Support for allowed wallet versions for wallet connection verification

## 0.1.2

### Patch Changes

- [`6f3bb5f`](https://github.com/mhbdev/ton-better-auth/commit/6f3bb5f293bf4ff3e61b91ee0a1cb7c7032eaec3) Thanks [@mhbdev](https://github.com/mhbdev)! - Fix wallet primary-state handling to consistently enforce a single primary wallet per user.

  - Normalize wallet primary flags in transactional `verify`, `link`, and `unlink` flows.
  - Self-heal inconsistent states where a user has zero or multiple primary wallets.
  - Add integration tests covering missing-primary and duplicate-primary wallet scenarios.
