# Attribution

`langfuse-model-prices.json` is a verbatim copy of Langfuse's public model
price file, used to seed price version 1 (docs/specs/13-tokens-and-cost.md D4).

- Source: https://github.com/langfuse/langfuse/blob/734cc86329ae4d6cc09aa4d19b1764730d6e636a/worker/src/constants/default-model-prices.json
- Commit: `734cc86329ae4d6cc09aa4d19b1764730d6e636a` (2026-10-07)
- SHA-256 of the file: `bd417fa3c138eaed85f2fe039b41777dc47ade7aec53023ed7f5d7b4ed311e93`
- Licence: MIT ("MIT Expat"), which covers the repository outside its `ee/`
  directories; the file is under `worker/src/constants/`, outside them.

The file is not edited here. A newer snapshot replaces it whole, with this file
updated to the new commit; the seed only creates a version when none exists,
so a refresh reaches an existing database as an admin price version.

## Licence

```
Copyright (c) 2023-2026 ClickHouse, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
