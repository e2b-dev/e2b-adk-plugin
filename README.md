# E2B for Google ADK

Give [Google ADK](https://google.github.io/adk-docs/) agents code, shell, file and background-process tools that run in
an isolated [E2B](https://e2b.dev) sandbox. Available for Python and TypeScript.

| | Package | Registry | Docs |
| --- | --- | --- | --- |
| Python | `e2b-adk` | [PyPI](https://pypi.org/project/e2b-adk/) | [packages/e2b-adk-python](packages/e2b-adk-python/README.md) |
| TypeScript | `@e2b/adk` | npm (with the first release) | [packages/e2b-adk-js](packages/e2b-adk-js/README.md) |

## Setup

```bash
pip install e2b-adk
# or
npm install @google/adk @e2b/adk
```

Set `E2B_API_KEY` ([get one](https://e2b.dev/dashboard)) and a model key such as `GOOGLE_API_KEY`.

## Configuration

- Python: [plugin configuration](packages/e2b-adk-python/README.md#configuration)
- TypeScript: [toolset configuration](packages/e2b-adk-js/README.md#configuration)

## Development

```bash
pnpm install
pnpm check          # both packages: lint, types, tests, build
```

The Python package uses [uv](https://docs.astral.sh/uv/); run `uv sync --extra dev` in `packages/e2b-adk-python` first.
Releases go through [changesets](.changeset/README.md): both packages share one version.

## License

[MIT](LICENSE)
