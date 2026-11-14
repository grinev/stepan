# Releasing

Release preparation is local. It does not publish, stage, commit, tag, push,
or close a task-board release. The npm package and GitHub Release are separate
outputs of the same release commit. There is no automatic Publish workflow yet.

## Prepare the version and notes

Use Node.js 22+, npm and Git from a source checkout. Check the branch, Git status
and release scope first; do not sweep unrelated changes into a release.

```sh
npm run release:prepare -- 0.1.0
```

The script updates `package.json` and both root version fields in
`package-lock.json`, without changing dependencies. It accepts an explicit
stable `X.Y.Z` or `patch`, `minor`, `major`. Downgrades, `0.0.0`, RC versions
and an existing target tag are refused. Preparing the same untagged version
again is safe and keeps existing notes.

**First release:** write `docs/release-notes/v0.1.0.md` by hand as a short
overview of the available features. No previous tag means no commit-log draft:
the script tells you to write the notes rather than treating all development
commits as a changelog.

**Later releases:** the script seeds `docs/release-notes/v<version>.md` from
commits since the nearest reachable stable version tag below the target version.
Fetch the repository's release tags before preparing; a checkout with no release
tags is treated as a first release. Git errors are reported, not hidden as an
empty history. Preview the draft without writing files:

```sh
npm run release:notes:preview
```

`STP-N: ...` subjects are retained without inferring a type from task IDs.
Conventional Commits are grouped; release-only commits are omitted. This is
raw material, not the finished release notes.

### Agent command: `/prepare-release`

OpenCode and Claude Code have thin project commands that read this guide.
Pass a version, for example `/prepare-release 0.1.0`. The agent:

1. Reads the requested version and checks branch/status/scope. If no version
   was named, proposes one and waits for agreement before changing versions.
   Stops on unrelated changes instead of discarding or staging them.
2. Runs `npm run release:prepare -- <version>`.
3. Writes the first release's notes manually, or curates later drafts against
   the actual Git changes and current product documentation.
4. Runs `npm run check`, saving the full output to a session scratchpad log;
   reports the result and leaves all release changes for human inspection.
5. Hands back the exact changed paths and suggested commit message. Does not run
   `git add`, `git commit`, `git tag`, `git push`, `npm publish`, or `gh release create`.

Write notes in English, about shipped behaviour: a bold feature name and one
short sentence about what a user can do. Use only meaningful populated sections
such as Changes, Fixes, or Major Changes. Do not paste commit subjects as finished
notes or pad them with task IDs, internal refactors, tests, CI or repo housekeeping.
Verify claims against implemented behaviour, not future items in PRODUCT.md.
For later releases, keep the generated compare link. The first release needs
no invented previous-tag link.

## Verify the package

```sh
npm ci
npm run check
npm pack --dry-run --json
npm pack --pack-destination <artifact-directory>
```

Save the whole `check` output to a log rather than truncating it.
`prepack` runs `npm run build`, so packaging compiles current sources without
depending on a pre-existing `dist`. Inspect the archive: `package.json`, README,
LICENSE and compiled `dist` modules/maps only; no source-mode markers, tests,
release tooling, skill, board, secrets or local state. `yaml` must remain a
runtime dependency; the executable is `dist/cli.js` with its Node shebang.

Use a throwaway project, private npm cache/home/config roots and an isolated
global prefix, not your working project or existing global installation:

```sh
npm install -g <tarball> --prefix <private-prefix>
```

Invoke the bin inside that prefix (`<private-prefix>/stepan.cmd` on Windows,
`<private-prefix>/bin/stepan` on macOS/Linux). Check `--help` and `--version`.
Also check npx with the local artifact, not the unpublished registry `latest`:

```sh
npx --yes --package=<tarball> stepan --version
npx --yes --package=<tarball> stepan --help
```

From the disposable project, use the installed bin to install the flow from
GitHub:

```sh
stepan install grinev/stepan-flows --flow plan-and-implement
stepan start plan-and-implement "Package smoke test"
```

Substitute the isolated bin for `stepan`. Follow the returned commands, using
`current` between transitions. Record clearly labelled smoke outcomes for
plan, approval, implementation and final completion; this validates the
package, not an agent's implementation or a real user approval. Confirm
definitions and run history are written under the disposable project's
`.stepan/`, with no `.dev-data/` next to the installed package.

```sh
npm publish <tarball> --dry-run --access public --tag latest
```

This last command does not publish. A tarball tested from an uncommitted tree
is a **candidate**, not the final release artifact.

## Publish manually

After inspecting the changes, make the release commit separately. Build the
final tarball from a clean checkout of that exact commit, with no pre-existing
`dist` or untracked build output. Repeat the full check, archive inspection,
isolated npm/npx and flow smoke above. Record the release commit SHA, tarball
path and SHA-256. The final verified tarball is what you publish: do not repack
an edited working directory afterwards.

Check npm authentication (`npm whoami`, or sign in with `npm login`) and publish
rights for the `@grinev` scope. Confirm the name/version is not already published.
The public registry does not allow overwriting an existing name/version.

```sh
npm publish <verified-final-tarball> --access public --tag latest
```

`publishConfig.access` also declares public access. Local manual publication
does not need CI provenance or an automation token.

After npm succeeds, push the release commit and create the matching tag and
GitHub Release. Use the recorded SHA explicitly, not whichever commit HEAD
happens to point to later. For the first release:

```sh
git tag v0.1.0 <release-commit-sha>
git push origin v0.1.0
gh release create v0.1.0 --verify-tag --title v0.1.0 --notes-file docs/release-notes/v0.1.0.md
```

GitHub CLI authentication and permission to create tags/releases are required;
alternatively use GitHub's release UI with the same tag, commit and notes.
If npm succeeds but tagging or GitHub Release creation fails, finish those
operations for the recorded commit without trying to publish the same npm
version again or moving an existing release tag.

Finally check the actual registry version with an isolated global install and
`npx @grinev/stepan@latest`, repeating help/version and the flow smoke. A local
tarball test is not evidence that a registry release succeeded.
