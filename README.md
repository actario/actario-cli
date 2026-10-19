# Actario CLI — source

This is the source of [`@actario/cli`](https://www.npmjs.com/package/@actario/cli),
the program the [Actario plugin](https://github.com/actario/actario-plugin)
runs on your machine.

It is published for one reason: **Actario claims your conversations are
redacted before anything leaves your machine, by rules no flag can switch
off.** That claim is worth nothing if you cannot read the code that makes it.

## Where the claim lives

| | |
|---|---|
| The rules | [`packages/redaction/src/`](packages/redaction/src/) |
| What they are tested to do | [`packages/redaction/src/redaction.spec.ts`](packages/redaction/src/redaction.spec.ts) — 49 cases |
| Where redaction sits in the pipeline | [`packages/capture/src/pipeline.ts`](packages/capture/src/) |
| What is read off your disk, and from where | [`packages/adapters/src/`](packages/adapters/src/) |
| What is sent, and to where | [`apps/cli/src/api.ts`](apps/cli/src/api.ts) |

```
npm install
npm test        # the full suite, no network, no account
npm run build   # bundle it the way the published package is bundled
```

## What this repository is not

**It is not where development happens.** It is generated from a private
monorepo at each release and force-pushed, so it has no meaningful history and
pull requests against it cannot be merged. If you have found a bug or a session
format has changed, open an issue — that is the useful channel today, and if
there is enough of it this becomes a real repository.

**It is not everything.** The Actario web application, the worker, the database
schema and the corpus admission logic are not here and are not licensed here.
What is here is the whole of what runs on your machine.

**The published tarball is built from the private monorepo**, not from this
tree, so `npm run build` gives you a comparable bundle rather than a
bit-identical one. Reproducible builds are not solved here yet.

## Naming

The packages are called `@distill/*` and the wire format is `distill.chat/v1`.
Distill was this product's name until September 2026. The contracts between
machines were deliberately left alone when it was renamed, because changing
them would invalidate data already uploaded and tokens already issued.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
