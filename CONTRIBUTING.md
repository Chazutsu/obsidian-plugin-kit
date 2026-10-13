# Contributing

Thanks for helping improve this project.

## Development

1. Install Node.js 24 and pnpm.
2. Run `pnpm install --frozen-lockfile` from the repository root.
3. Run this package's `build`, `typecheck`, and `test` scripts before opening a pull request.

Keep product-specific design and copy inside the product. Promote code to `obsidian-plugin-kit` only after the same Obsidian-specific constraint has been proven in at least two plugins.

## Changes

- Keep pull requests focused.
- Add regression tests for behavior changes.
- Do not include Vault content, credentials, access tokens, or local Obsidian settings.
- Preserve the existing Obsidian plugin ID unless a migration plan is included.

By contributing, you agree that your contribution is licensed under the MIT License.

