import path from "node:path";

export function isStructuredPath(logical) {
  return (
    logical.startsWith("metrics/") ||
    logical.startsWith("reports/") ||
    logical.startsWith("dims/") ||
    logical.startsWith("rules/")
  );
}

export function samePath(logical, targetRoot) {
  if (isStructuredPath(logical)) {
    const dir = path.posix.dirname(logical);
    switch (targetRoot) {
      case "spec":
        return path.posix.join(dir, "spec.md");
      case "playbooks":
        return path.posix.join(dir, "playbook.md");
      case "templates":
        return path.posix.join(dir, "template.md");
      default:
        return logical;
    }
  }
  const parts = logical.split("/");
  if (parts.length < 2) return logical;
  return `${targetRoot}/${parts.slice(1).join("/")}`;
}

export function isReferenceSpecPath(logical) {
  if (logical.startsWith("dims/") || logical.startsWith("rules/")) {
    return path.posix.basename(logical) === "spec.md";
  }
  if (!logical.startsWith("spec/")) return false;
  const rest = logical.slice("spec/".length);
  if (rest.startsWith("common/")) return true;
  return rest.startsWith("dim-");
}

export const KIND_SPEC = "spec";
export const KIND_PLAYBOOK = "playbook";
export const KIND_TEMPLATE = "template";
export const SPEC_TYPE_METRIC = "metric";
export const SPEC_TYPE_CONCEPT = "concept";
