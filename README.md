# Obsidian Plugin Kit

[日本語](./README.ja.md)

Non-visual foundations for building and shipping Obsidian plugins. The package currently provides shared Rolldown configuration, strict TypeScript defaults, and deployment primitives.

## Package boundary

- `./rolldown`: keeps Obsidian external and emits a single CommonJS bundle
- `./tsconfig`: strict type-checking defaults for React and TypeScript plugins
- `./deploy`: validates manifests, version mappings, release artifacts, and existing Vault roots; rejects targets outside `plugins/<plugin-id>`; and treats multi-vault deployment plus community-plugin activation as one transaction with rollback. Target initialization requires an explicit opt-in.

The source repository is public, while npm publication is intentionally disabled with `private: true`. Consumers install a tagged Git revision so every shared primitive remains reviewable and reproducible.

## Promotion criteria

- The behavior is duplicated in at least two plugins.
- It addresses an Obsidian-specific constraint without depending on either product's visual language.
- Its API can be tested independently.
- One product cannot introduce a breaking change for the other.

Do not share UI components, colors, spacing, radii, or product copy. Add a shared primitive only after the evidence meets every criterion above.

## Promotion flow

1. Solve the problem inside one plugin.
2. Confirm that the same problem exists in a second product.
3. Remove product-specific language and presentation.
4. Add independent tests and a backward-compatibility contract.
5. Move the primitive into this package and consume a tagged release.

Potential future reuse is not sufficient justification. Promote code only when the coupling cost is lower than maintaining the duplication.

