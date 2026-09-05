# Ledger import third-party libraries

These files are vendored locally so the static application does not depend on a CDN at runtime.

| Library | Version | Upstream source | License | Vendored file | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| SheetJS Community Edition | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz | Apache-2.0 | `xlsx-0.20.3.min.js` | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` |
| fflate | 0.8.2 | https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz | MIT | `fflate-0.8.2.min.js` | `c3b34f2e9f5e74d4d7d64e01cac7a0c01954c6c406414d42185c7b53d6875ddf` |

Downloaded archive hashes:

- SheetJS 0.20.3: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- fflate 0.8.2: `61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc9998d141dc`

The corresponding license texts are kept beside the vendored files. No changes were made to the upstream JavaScript bundles.
