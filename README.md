# pi-edit

A simple Pi coding-agent extension that adds an `edit` tool for exact string replacement in files.

## Features

- Replaces exact text matches in a file
- Requires a unique match by default
- Supports `replace_all` for replacing every occurrence
- Preserves line endings and BOMs
- Shows diff previews/results in Pi

## Install

```sh
npm install
```

## Test

```sh
npm test
```

## Tool input

```json
{
  "file_path": "src/example.ts",
  "old_string": "text to replace",
  "new_string": "replacement text",
  "replace_all": false
}
```

`old_string` must match exactly, including whitespace and newlines.
