export function issueMarkerFromWorkspace(identifier) {
  const match = String(identifier || "").match(
    /(?:^|\/)(issue-[A-Za-z0-9._-]+)$/
  );
  return match ? match[1] : null;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function issueNamePattern(marker) {
  return new RegExp(
    `^ai-worker-.+-${escapeRegExp(marker)}-[0-9a-f]{12}$`
  );
}

export function workerMatchesIssueRelease({
  workspaceLabel,
  containerName,
  projectLabel,
  requestedWorkspace,
  allowedProjects = [],
  knownProjects = []
}) {
  const name = String(containerName || "").replace(/^\//, "");
  const workspace = String(workspaceLabel || "");
  const project = String(projectLabel || "");
  const marker = issueMarkerFromWorkspace(requestedWorkspace);

  if (
    project &&
    knownProjects.includes(project) &&
    !allowedProjects.includes(project)
  ) {
    return false;
  }

  if (workspace === requestedWorkspace) return true;
  if (!marker) return false;
  if (workspace === marker || workspace.endsWith(`/${marker}`)) return true;
  return issueNamePattern(marker).test(name);
}
