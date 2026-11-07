# Third-party notices

This plugin's code is licensed under the MIT License (see [LICENSE](./LICENSE)).
Third-party models, libraries, and assets bundled with or fetched by this
plugin retain their own licenses, listed below.

## Moonshine Voice (speech-to-text)

- **What:** the prebuilt `moonshine-voice` native library (`v0.1.5`,
  staged into `moonshine-sys/lib/` by
  `moonshine-sys/scripts/download-lib.sh`), the vendored
  `moonshine-c-api.h` / `moonshine-cpp.h` headers in `moonshine-sys/`, and
  the `medium-streaming-en` model files fetched by
  `scripts/download-moonshine-models.sh` into `assets/moonshine/`.
- **Source:** <https://github.com/moonshine-ai/moonshine> and
  <https://download.moonshine.ai>.
- **License:** MIT. Per the upstream LICENSE, "any speech-to-text model not
  named in that list is MIT, including every streaming model" — the
  `medium-streaming-en` model used here is MIT.

```
MIT License

Copyright (c) 2025 Useful Sensors, Inc. (dba Moonshine AI)

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
