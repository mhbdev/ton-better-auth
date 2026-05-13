# ton-better-auth Skills

AI agent skills for integrating [TON Connect](https://ton.org/ton-connect) wallet authentication with [Better Auth](https://better-auth.com).

## Installation

Install skills via the skills.sh CLI:

```bash
npx skills add mhbdev/ton-better-auth
```

## Available Skills

### ton-better-auth

Integrate TON Connect wallet authentication into Better Auth projects. Covers:
- Server plugin setup with `tonConnect()`
- Client plugin configuration with `tonConnectClient()`
- React integration with `@tonconnect/ui-react`
- API endpoints and client methods
- Standalone `verifyTonProof()` usage

### ton-better-auth-runtime

Handle runtime compatibility across different JavaScript environments:
- Node.js 18+ / Bun (no setup needed)
- Cloudflare Workers (nodejs_compat flag)
- Vercel Edge Runtime (polyfills or Node.js runtime)
- Deno (node:buffer import)
- Browser (bundler polyfills)

## Usage

After installing, agents will automatically have access to these skills when working on Better Auth projects that need TON wallet authentication.

### Example Prompts

- "Add TON Connect sign-in to my Better Auth project"
- "Set up wallet authentication for my TON dApp"
- "Configure ton-better-auth for Cloudflare Workers"
- "Fix 'Buffer is not defined' error in ton-better-auth"

## Resources

- [Package Repository](https://github.com/mhbdev/ton-better-auth)
- [npm Package](https://www.npmjs.com/package/ton-better-auth)
- [Better Auth Documentation](https://better-auth.com)
- [TON Connect Documentation](https://docs.ton.org/v3/guidelines/ton-connect/verifying-signed-in-users)

## License

MIT
