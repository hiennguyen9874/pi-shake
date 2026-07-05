# pi-shake

`pi-shake` is a Pi coding-agent extension that lets you manually "shake" heavy content out of future model context without rewriting the saved session history.

It registers a `/shake` command for Pi. When you run it, the extension records lightweight pruning rules in the session. On later context-building events, those rules are applied to the messages sent to the model, replacing or removing selected heavy content.

## What it does

- Replaces old tool results with compact placeholders such as `[shaken ~123 tokens]`.
- Replaces large fenced code blocks or XML-like blocks with compact placeholders.
- Can remove images already present in the current session from future context.
- Persists shake state in the session via a custom `pi-shake-state` entry.
- Does **not** destructively edit the original conversation/session entries.

## Usage

Install or enable this repository as a Pi package/extension. The package exposes `./src/index.ts` through the `pi.extensions` field in `package.json`.

Run one of the following commands inside Pi:

```text
/shake
/shake elide
/shake images
```

### `/shake` or `/shake elide`

Scans the current session branch and records rules for content that can be elided from future context:

- non-protected tool results
- large fenced code blocks
- large XML-like blocks

Future model context replaces matched content with placeholders, for example:

```text
[shaken ~850 tokens]
```

### `/shake images`

Records signatures for images currently present in the session. Future context removes those exact images while keeping newer images that were added after the command ran.

If an image-only content array becomes empty, it is replaced with:

```text
[image removed]
```

## How it works

1. The extension registers a `shake` command and listens to Pi lifecycle/context events.
2. On `session_start` and `session_tree`, it reconstructs shake state from persisted `pi-shake-state` custom entries.
3. When `/shake` runs, it waits for Pi to become idle, scans the current session branch, and appends a new `pi-shake-state` entry containing either:
   - elision rules for tool results/large blocks, or
   - image signatures for `/shake images`.
4. On each `context` event, it applies the recorded state to the outgoing model messages only.
5. The stored session remains unchanged, so shaken content can still exist in history while being omitted from future prompts.

## Protected content

The extension avoids shaking protected tool results, including:

- `skill` tool results
- internal skill reads using `skill://...`

This helps preserve content Pi may need for skill behavior.

## Development

```bash
npm install
npm test
```

The main extension implementation is in [`src/index.ts`](src/index.ts).
