# Changelog

All notable changes to Agent Bot are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.8] - 2026-08-01

- Deliver Codex-generated images to Lark as previewable final results, including image-only turns and completion recovery after restart.
- Fix fresh Lark apps receiving only private and @-mention messages by always requesting all-user group-message delivery during initialization, with `feishu.respondToAllGroupMessages` controlling whether ordinary group messages receive a response.
- Keep Agent and project-directory prefixes out of Codex task titles when synchronizing a renamed Lark group.

## [0.1.7] - 2026-07-31

- Automatically wait up to five minutes for optional Lark configuration during `init`, with `Y` as the sole option to skip and continue.

## [0.1.6] - 2026-07-31

- Prevent `init --reset` from reusing credentials loaded from the Profile before its `.env` was backed up.

## [0.1.5] - 2026-07-31

- Show the running Agent Bot version on startup status cards.
- Add `agent-bot --profile <directory> init --reset` to back up and fully reconfigure an explicitly selected Profile while retaining all reset backups.

## [0.1.4] - 2026-07-31

- Show the active Lark App ID in `agent-bot server status` and its JSON output.
- Use English consistently for all Agent Bot CLI interface text.
- Keep system-generated restart reasons in Chinese to match the Lark status cards.

## [0.1.3] - 2026-07-31

- Show the incoming-message reaction before chat persistence, image downloads, queue waits, commands, or runtime work begins.
- Verify Feishu startup through notification delivery before reporting the server as ready.
- Support isolated Agent Bot profiles through explicit profile directories.
- Start the selected profile's server automatically after successful initialization.
- Persist Supervisor crash context and enable privacy-reduced Node diagnostic reports by default.
- Add a `Cancel` action to pending safe-restart status cards.

## [0.1.2] - 2026-07-29

- Make npm release retries recover a missing GitHub Release from the version tag.
- Wait for the Feishu WebSocket connection before reporting the server as ready, and reject server startup when bot credentials are missing.
- Make Feishu initialization recover safely from interruption with exclusive initialization locking, durable credential writes, and new app registration whenever a complete credential pair was not saved.

## [0.1.1] - 2026-07-29

- Add `npm run release` to prepare the next stable version and changelog.
- Publish new package versions automatically after successful CI for a push to `master`.

## [0.1.0] - 2026-07-29

- Initial public npm package.
