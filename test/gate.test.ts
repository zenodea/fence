import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../src/herdr/gate.ts";

test("a pen may report its own pane's status and nothing else", () => {
  assert.ok(judge({ method: "pane.report_agent", params: { pane_id: "w1:p1" } }, "w1:p1").allowed);
  assert.ok(judge({ method: "ping" }, "w1:p1").allowed);
  assert.ok(!judge({ method: "pane.report_agent", params: { pane_id: "w1:p2" } }, "w1:p1").allowed);
  assert.ok(!judge({ method: "pane.report_agent", params: { pane_id: "w1:p1" } }, null).allowed);
  for (const method of ["pane.split", "pane.send_text", "pane.send_input", "pane.read", "workspace.create", "agent.prompt", "plugin.link", "plugin.action.invoke"]) {
    assert.ok(!judge({ method, params: { pane_id: "w1:p1" } }, "w1:p1").allowed, method);
  }
  assert.ok(!judge("garbage", "w1:p1").allowed);
});
