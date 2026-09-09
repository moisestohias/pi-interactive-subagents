/**
 * Filesystem-safe name helpers. Single home for the slug chain previously
 * pasted 5× across launch/resume paths in index.ts.
 */

/** Slugify a display name for use in artifact / script filenames. */
export function slugifyName(name: string | null | undefined): string {
  return (
    (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/** `<slug>-<id>.sh` launch-script filename. */
export function launchScriptName(name: string | null | undefined, id: string): string {
  return `${slugifyName(name)}-${id}.sh`;
}

/** `<slug>-resume-<stamp>.sh` resume-script filename. */
export function resumeScriptName(
  name: string | null | undefined,
  stamp: number | string = Date.now(),
): string {
  return `${slugifyName(name) || "resume"}-resume-${stamp}.sh`;
}

/** `<slug>-<timestamp>.md` context/artifact filename. */
export function contextArtifactName(
  name: string | null | undefined,
  timestamp: string,
  suffix = "",
): string {
  return `${slugifyName(name)}-${timestamp}${suffix}.md`;
}

/** Session-dir path segment for a cwd: `--<cwd with /:\ replaced>--`. */
export function safePathSegment(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
