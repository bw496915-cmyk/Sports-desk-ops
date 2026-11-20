/**
 * @file tests/bridge_websocket_drain.test.ts
 * @description A telemetry socket paused by the wager hub on backpressure must be
 * resumed by the bridge websocket's drain handler; without it the socket stays
 * paused until it closes.
 */

import { expect, test } from "bun:test";

import { bridgeWebsocket } from "../services/sportsdesk_webview_server.ts";

test("drain resumes a paused bridge socket", () => {
  const calls: string[] = [];
  const ws = {
    resume: (): void => {
      calls.push("resume");
    },
  } as never;

  bridgeWebsocket.drain(ws);

  expect(calls).toEqual(["resume"]);
});
