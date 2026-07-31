# 15 — Release Process

Releases are created from version tags and are never published from pull requests.

## Publish

1. Update `package.json` version and release notes.
2. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Commit the version change, then create and push the matching tag, for example `v0.2.0`.
4. `.github/workflows/release.yml` verifies the tag, builds on macOS/Windows/Linux, creates `SHA256SUMS.txt`, and publishes a GitHub Release.

The tag must exactly equal `v${package.json.version}`. CI rejects mismatches.

## Signing and notarization

Unsigned packages are still produced when signing secrets are absent. Public releases should configure:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

Certificate values must be stored as GitHub Actions secrets, never committed. `electron-builder` consumes these standard environment variables during the platform build. Verify signatures and notarization on downloaded release artifacts before announcing a release.

## Recovery

If packaging fails, fix the cause and rerun the failed jobs. Do not move an existing public tag to different source. For source changes, bump the patch version and create a new tag.
