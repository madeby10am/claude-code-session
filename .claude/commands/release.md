---
description: Cut a new release — bump version, commit, tag, push, create GitHub release, build + upload VSIX
argument-hint: "[patch|minor|major|<explicit-version>]"
---

Cut a new release of this extension end-to-end.

**Argument:** `$ARGUMENTS` — a bump type (`patch`, `minor`, `major`) or an explicit version like `2.1.0`. If empty, default to `patch`.

## Steps

Execute these in order. Stop and ask the user if anything looks wrong at any step — don't silently work around failures.

1. **Confirm a clean working tree.** Run `git status --porcelain`. If there are uncommitted changes, stop and ask the user whether to include them, stash them, or abort.

2. **Read current version.** Parse `package.json`'s `version` field.

3. **Compute the new version.**
   - `patch` → bump last number (e.g. `2.0.1` → `2.0.2`)
   - `minor` → bump middle, reset patch (e.g. `2.0.1` → `2.1.0`)
   - `major` → bump first, reset rest (e.g. `2.0.1` → `3.0.0`)
   - explicit `X.Y.Z` → use as-is
   - Confirm the target version with the user before proceeding if the bump type was ambiguous.

4. **Gather changes since the last tag.** Run `git log $(git describe --tags --abbrev=0)..HEAD --oneline`. Group the commits into human-readable sections (Features / Fixes / Docs / Chore) — you'll use this for the release notes.

5. **Bump `package.json`.** Edit the `version` field to the new value. Do not touch anything else.

6. **Commit the bump.** Commit message: `chore: release v<new-version>` with the standard `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

7. **Tag + push.**
   - `git tag v<new-version>`
   - `git push origin main`
   - `git push origin v<new-version>`

8. **Create the GitHub release.** Use `gh release create v<new-version>` with:
   - `--title "v<new-version> — <short summary>"` — derive a short summary from the grouped commits (one phrase, no trailing period)
   - `--notes` — a markdown body with sections for Features / Fixes / etc. based on the commits. Use a HEREDOC to pass multi-line notes. Reference commit hashes where it adds clarity.

9. **Build + upload the VSIX.** Run `npm run release`. This packages the `.vsix` and uploads it to the tag you just created. Verify the upload with `gh release view v<new-version> --json assets --jq '.assets[] | .name'`.

10. **Report back.** One-line summary with the release URL.

## Notes

- If step 9 fails because the tag doesn't exist yet on the remote (race condition), wait a beat and retry once.
- Never force-push. Never skip hooks. If a pre-commit hook fails, fix the underlying issue and create a new commit — don't `--no-verify`.
- Don't publish to the VS Code Marketplace unless the user explicitly asks — GitHub release only.
