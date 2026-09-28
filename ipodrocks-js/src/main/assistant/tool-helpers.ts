import { validateFolderPath } from "../ipc/common";

/**
 * Path validation for tools — *is* `validateFolderPath()`, not a mirror of it.
 *
 * It used to be a copy, and a copy of a gate is the weaker gate the moment the
 * original is fixed: Rocksy is a second front door (`assistant:confirmAction`
 * runs any tool on a client-supplied object), so a copy that still stat'ed
 * before checking the allowlist would keep the path-existence oracle open
 * through the assistant after the channel closed it.
 */
export function validateFolderPathForTool(
  rawPath: string
): { path: string } | { error: string } {
  return validateFolderPath(rawPath);
}
