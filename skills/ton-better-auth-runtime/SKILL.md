---
name: ton-better-auth-runtime
description: >
  Handle runtime compatibility for ton-better-auth across different environments (Node.js, Bun, Cloudflare Workers, Vercel Edge, Deno, Browser).
  This skill provides specific configuration for each runtime to ensure Buffer and other Node.js primitives are available.
license: MIT
compatibility: Works with all JavaScript runtimes
metadata:
  author: mhbdev
  version: "0.1.1"
  repository: https://github.com/mhbdev/ton-better-auth
---

# TON Better Auth Runtime Compatibility

Configure `ton-better-auth` for different JavaScript runtimes. The package depends on TON libraries (`@ton/core`, `@ton/crypto`, `@ton/ton`) that require Node.js primitives, primarily the global `Buffer`.

## Runtime Requirements Matrix

| Runtime | Buffer Available | Setup Required | Notes |
|---------|------------------|----------------|-------|
| Node.js 18+ | Yes | None | Works out of the box |
| Bun | Yes | None | `Buffer` provided out of the box |
| Cloudflare Workers | With flag | Enable `nodejs_compat` | Requires compatibility flag |
| Vercel Edge Runtime | No | Use Node.js runtime or polyfill | Edge runtime doesn't polyfill `Buffer` |
| Deno | With import | Import `node:buffer` | Most bundlers handle automatically |
| Browser | No | Bundler polyfill required | Use vite-plugin-node-polyfills or webpack fallback |

## Configuration by Runtime

### Node.js 18+

No configuration needed. `Buffer` is globally available.

### Bun

No configuration needed. `Buffer` is globally available.

### Cloudflare Workers

Enable the Node.js compatibility flag in `wrangler.toml`:

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"
```

### Vercel Edge Runtime

**Option A: Use Node.js runtime (recommended)**

Don't set `export const runtime = "edge"` on your auth route handlers. They'll run on Node.js by default.

**Option B: Polyfill Buffer in Edge runtime**

```typescript
// app/api/auth/[...all]/route.ts
import { Buffer } from "buffer";
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

// Polyfill Buffer for Edge runtime
globalThis.Buffer = globalThis.Buffer ?? Buffer;

export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["your-app.com"],
    }),
  ],
});

export const { GET, POST } = auth.handler;
```

### Deno

**Option A: Use deno.json configuration**

```json
{
  "compilerOptions": {
    "lib": ["deno.ns"]
  },
  "nodeModulesDir": true
}
```

**Option B: Import Buffer at entry point**

```typescript
// main.ts or auth.ts
import { Buffer } from "node:buffer";
globalThis.Buffer ??= Buffer;

// Now import and use ton-better-auth
import { tonConnect } from "ton-better-auth";
```

### Browser (Client-side Verification)

**Note**: `ton-better-auth` is designed for server-side use. If you need parts of it in the browser (e.g., pre-verifying signatures), install polyfills:

```bash
npm i -D buffer
```

#### Vite Configuration

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
});
```

#### Webpack 5 Configuration

```javascript
// webpack.config.js
const webpack = require("webpack");

module.exports = {
  resolve: {
    fallback: {
      buffer: require.resolve("buffer/"),
      crypto: require.resolve("crypto-browserify"),
      stream: require.resolve("stream-browserify"),
    },
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
    }),
  ],
};
```

#### Next.js (App Router) Edge Route

```typescript
// app/api/ton-verify/route.ts
import { Buffer } from "buffer";
import { verifyTonProof } from "ton-better-auth";

// Polyfill for Edge runtime
globalThis.Buffer = globalThis.Buffer ?? Buffer;

export async function POST(request: Request) {
  const body = await request.json();
  
  const result = await verifyTonProof(body, {
    allowedDomains: ["your-app.com"],
  });
  
  return Response.json(result);
}
```

## Framework-Specific Guides

### Next.js (Pages Router)

Place your auth configuration in `pages/api/auth/[...all].ts` (Node.js runtime by default):

```typescript
// pages/api/auth/[...all].ts
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["localhost:3000", "your-app.com"],
    }),
  ],
});

export default auth.handler;
```

### Next.js (App Router) with Middleware

```typescript
// app/api/auth/[...all]/route.ts
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

// This runs on Node.js runtime by default
export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["localhost:3000", "your-app.com"],
    }),
  ],
});

export const { GET, POST } = auth.handler;
```

### SvelteKit

```typescript
// src/routes/api/auth/[...all]/+server.ts
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["localhost:5173", "your-app.com"],
    }),
  ],
});

export const { GET, POST } = auth.handler;
```

### Express.js

```typescript
// server.ts
import express from "express";
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

const app = express();

const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["localhost:3000", "your-app.com"],
    }),
  ],
});

app.use("/api/auth", auth.handler);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
```

### Cloudflare Workers with Hono

```typescript
// src/index.ts
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

const app = new Hono();

const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      allowedDomains: ["your-app.com"],
    }),
  ],
});

app.route("/api/auth", auth.handler);

export default app;
```

## Error Diagnosis

### Common Error: "ReferenceError: Buffer is not defined"

**Symptoms**:
- Error occurs when `ton-better-auth` tries to verify a `ton_proof`
- Stack trace points to `@ton/crypto` or `@ton/core` internals

**Solutions**:
1. **Check runtime**: Confirm which runtime you're using
2. **Verify configuration**: Ensure proper polyfills are in place
3. **Test locally**: Run `console.log(typeof Buffer)` before importing `ton-better-auth`

### Debugging Steps

```typescript
// Add this before importing ton-better-auth
console.log("Buffer available:", typeof Buffer !== "undefined");
console.log("Global Buffer:", globalThis.Buffer ? "Yes" : "No");

// If Buffer is missing, polyfill it
if (typeof Buffer === "undefined") {
  const { Buffer } = await import("buffer");
  globalThis.Buffer = Buffer;
}

// Now import ton-better-auth
import { tonConnect } from "ton-better-auth";
```

## Performance Considerations

1. **Edge Runtime**: If using Vercel Edge, consider the cold start impact of polyfills
2. **Bundle Size**: Browser polyfills add ~50-100KB to your bundle
3. **Memory**: `Buffer` polyfills increase memory usage in serverless environments

## Best Practices

1. **Prefer Node.js runtime** for auth routes when possible
2. **Isolate polyfills** to only the routes that need `ton-better-auth`
3. **Test thoroughly** in your target runtime before deployment
4. **Monitor errors** for `Buffer`-related issues in production
5. **Keep dependencies updated** - TON libraries may change requirements

## Testing Runtime Compatibility

Create a test endpoint to verify `Buffer` is available:

```typescript
// app/api/buffer-test/route.ts
export async function GET() {
  const bufferAvailable = typeof Buffer !== "undefined";
  const bufferConstructor = bufferAvailable ? Buffer : null;
  
  return Response.json({
    bufferAvailable,
    bufferConstructor: bufferConstructor?.name || "none",
    runtime: process.env.NEXT_RUNTIME || "unknown",
  });
}
```

## When to Use This Skill

- Setting up `ton-better-auth` in a non-Node.js runtime
- Troubleshooting "Buffer is not defined" errors
- Configuring bundlers for client-side TON operations
- Deploying to serverless platforms (Vercel, Cloudflare, AWS Lambda)
- Building cross-runtime applications with TON authentication
