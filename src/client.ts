/**
 * Client-side plugin for `ton-better-auth`.
 *
 * Registers path methods and infers endpoint types from the server
 * plugin so callers get fully-typed helpers via `authClient.tonConnect.*`.
 *
 * Endpoints are exposed on the client as:
 *   authClient.tonConnect.challenge()
 *   authClient.tonConnect.verify({ address, network, public_key, proof })
 *   authClient.tonConnect.link({ address, network, public_key, proof })
 *   authClient.tonConnect.unlink({ address })
 *   authClient.tonConnect.wallets()
 */
import type { BetterAuthClientPlugin } from "better-auth";

import type { tonConnect } from "./plugin.js";

export const tonConnectClient = () => {
  return {
    id: "ton-connect",
    $InferServerPlugin: {} as ReturnType<typeof tonConnect>,
    pathMethods: {
      "/ton-connect/challenge": "POST",
      "/ton-connect/verify": "POST",
      "/ton-connect/link": "POST",
      "/ton-connect/unlink": "POST",
      "/ton-connect/wallets": "GET",
    },
  } satisfies BetterAuthClientPlugin;
};

export type TonConnectClientPlugin = ReturnType<typeof tonConnectClient>;
