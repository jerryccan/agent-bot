# Changelog

All notable changes to Agent Bot are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-07-29

- Make npm release retries recover a missing GitHub Release from the version tag.
- Wait for the Feishu WebSocket connection before reporting the server as ready, and reject server startup when bot credentials are missing.
- Make Feishu initialization recover safely from interruption with exclusive initialization locking, durable credential writes, and new app registration whenever a complete credential pair was not saved.

## [0.1.1] - 2026-07-29

- Add `npm run release` to prepare the next stable version and changelog.
- Publish new package versions automatically after successful CI for a push to `master`.

## [0.1.0] - 2026-07-29

- Initial public npm package.
