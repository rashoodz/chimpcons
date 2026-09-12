# Third-party licenses

`@consultchimps/xlsx` is licensed under the Apache License, Version 2.0. See the
[repository `LICENSE`](https://github.com/consultchimps/consultchimps/blob/main/LICENSE)
for the full text.

The published `dist` output of this package **bundles** the third-party code
listed below: the code is compiled into the shipped JavaScript rather than
installed as a separate runtime dependency. The notices below apply to that
bundled code.

## SheetJS Community Edition (`xlsx`) 0.20.3

- Copyright (C) 2012-present SheetJS LLC
- License: Apache License, Version 2.0
- Homepage: https://sheetjs.com/
- Source distribution: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

SheetJS is bundled rather than declared as a dependency because current SheetJS
releases are published from the SheetJS CDN instead of the npm registry.
Bundling keeps `npm install @consultchimps/xlsx` working in environments whose
package access is restricted to the npm registry.

```
Copyright (C) 2012-present   SheetJS LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Dependencies installed from the npm registry

`@zip.js/zip.js` (BSD-3-Clause), `jszip` (MIT or GPL-3.0-or-later), and `saxes`
(ISC) remain declared dependencies. They are installed from the npm registry
with their own license files and are not bundled into this package's output.
