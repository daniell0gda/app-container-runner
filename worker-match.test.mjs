import test from "node:test";
import assert from "node:assert/strict";
import {
  issueMarkerFromWorkspace,
  workerMatchesIssueRelease
} from "./worker-match.mjs";

const godotAliases = ["godot-td", "tower-defense", "poke-defense-godot"];
const knownProjects = [...godotAliases, "piwotworki"];

function match(overrides) {
  return workerMatchesIssueRelease({
    requestedWorkspace:
      "poke-defense-godot/issue-window-modals-skip-wood-frame",
    allowedProjects: godotAliases,
    knownProjects,
    ...overrides
  });
}

test("extracts issue marker from workspace tail", () => {
  assert.equal(
    issueMarkerFromWorkspace(
      "poke-defense-godot/issue-window-modals-skip-wood-frame"
    ),
    "issue-window-modals-skip-wood-frame"
  );
  assert.equal(
    issueMarkerFromWorkspace("godot-td/issue-window-modals-skip-wood-frame"),
    "issue-window-modals-skip-wood-frame"
  );
  assert.equal(issueMarkerFromWorkspace("issue-182/piwotworki"), null);
});

test("matches leftover alias worker by container name", () => {
  assert.equal(
    match({
      workspaceLabel:
        "poke-defense-godot/issue-window-modals-skip-wood-frame",
      containerName:
        "ai-worker-poke-defense-godot-poke-defense-godot-issue-window-modals-skip-wood-frame-fe49a69c486c",
      projectLabel: "poke-defense-godot"
    }),
    true
  );
});

test("matches when release uses a different alias and workspace prefix", () => {
  assert.equal(
    workerMatchesIssueRelease({
      workspaceLabel:
        "poke-defense-godot/issue-window-modals-skip-wood-frame",
      containerName:
        "ai-worker-poke-defense-godot-poke-defense-godot-issue-window-modals-skip-wood-frame-fe49a69c486c",
      projectLabel: "poke-defense-godot",
      requestedWorkspace: "godot-td/issue-window-modals-skip-wood-frame",
      allowedProjects: godotAliases,
      knownProjects
    }),
    true
  );
});

test("does not match a longer sibling slug", () => {
  assert.equal(
    workerMatchesIssueRelease({
      workspaceLabel: "poke-defense-godot/issue-window",
      containerName:
        "ai-worker-godot-td-poke-defense-godot-issue-window-aaaaaaaaaaaa",
      projectLabel: "godot-td",
      requestedWorkspace:
        "godot-td/issue-window-modals-skip-wood-frame",
      allowedProjects: godotAliases,
      knownProjects
    }),
    false
  );
});

test("does not match a shorter prefix slug", () => {
  assert.equal(
    workerMatchesIssueRelease({
      workspaceLabel:
        "poke-defense-godot/issue-window-modals-skip-wood-frame",
      containerName:
        "ai-worker-godot-td-poke-defense-godot-issue-window-modals-skip-wood-frame-bbbbbbbbbbbb",
      projectLabel: "godot-td",
      requestedWorkspace: "godot-td/issue-window",
      allowedProjects: godotAliases,
      knownProjects
    }),
    false
  );
});

test("rejects the same slug on a foreign known project", () => {
  assert.equal(
    match({
      workspaceLabel: "piwotworki/issue-window-modals-skip-wood-frame",
      containerName:
        "ai-worker-piwotworki-piwotworki-issue-window-modals-skip-wood-frame-cccccccccccc",
      projectLabel: "piwotworki"
    }),
    false
  );
});

test("exact workspace still matches when there is no issue marker", () => {
  assert.equal(
    workerMatchesIssueRelease({
      workspaceLabel: "direct-build/tower-defense",
      containerName: "ai-worker-godot-td-direct-build-tower-defense-dddddddddddd",
      projectLabel: "godot-td",
      requestedWorkspace: "direct-build/tower-defense",
      allowedProjects: godotAliases,
      knownProjects
    }),
    true
  );
});
