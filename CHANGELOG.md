# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
When publication begins, releases will remain in the `0.1.x` series and increment only the patch component.

## [Unreleased]

### Added

- `obsidian-plugin-kit/rolldown`, which creates a CommonJS Obsidian plugin bundle, externalizes Obsidian, Electron, Node.js built-ins, and caller-provided modules, resolves the configured TypeScript project, and applies development or production sourcemap and minification defaults.
- `obsidian-plugin-kit/tsconfig`, a reusable strict TypeScript configuration for Obsidian plugin projects.
- `obsidian-plugin-kit/deploy` manifest and `versions.json` contract validation, release artifact collection, and SHA-256 integrity verification.
- Transactional artifact deployment with staging, backup restoration, and cleanup when a write or integrity check fails.
- Transactional multi-Vault deployment and community-plugin activation, including duplicate target detection through real paths and rollback across previously updated Vaults.
- Type declarations and compatibility tests for every public package export.

### Security

- Deployment targets are restricted to `.obsidian/plugins/<plugin-id>` paths before any files are written.

The package remains private and unpublished. Versioned sections and comparison links will be added when the repository URL and first release are finalized.

