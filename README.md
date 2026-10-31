# paseo-openrouter-usage

A [Paseo](https://paseo.sh) plugin that adds OpenRouter credits, key limit, and spend to the Usage panel.

```bash
paseo plugin install git:kiawin/paseo-openrouter-usage
```

See [OVERVIEW.md](OVERVIEW.md) for setup.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload openrouter-usage
```
