# Third-party software

Keystone bundles or downloads the following open-source components. Their licenses apply to those components only.

## Bundled in `keystone_worklog/static/vendor/`

| Component | Version | License | Used for |
| --- | --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | Rendering Markdown |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.1.6 | Apache-2.0 or MPL-2.0 | Sanitizing rendered HTML |
| [KaTeX](https://github.com/KaTeX/KaTeX) (JS, CSS, fonts) | 0.16.11 | MIT | Rendering LaTeX math |

The license headers are kept at the top of each minified file.

## Downloaded on first use (or bundled with `keystone-worklog-bundle` into `models/`)

| Component | Version | License | Used for |
| --- | --- | --- | --- |
| [Transformers.js](https://github.com/huggingface/transformers.js) (includes ONNX Runtime Web) | 3.0.2 | Apache-2.0 (ONNX Runtime: MIT) | Running the embedding model in the browser |
| [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) ([Xenova ONNX export](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) | – | Apache-2.0 | Meaning search |

## Python packages (installed with pip, not bundled)

| Package | License |
| --- | --- |
| [Flask](https://github.com/pallets/flask) and its dependencies | BSD-3-Clause |
| [LanceDB](https://github.com/lancedb/lancedb) (optional) and its dependencies, e.g. pyarrow, numpy, pydantic | Apache-2.0 / BSD / MIT |
| [pypdf](https://github.com/py-pdf/pypdf) (optional, `documents`) | BSD-3-Clause |
| [python-docx](https://github.com/python-openxml/python-docx) and [python-pptx](https://github.com/scanny/python-pptx) (optional, `documents`) and their dependencies lxml, Pillow, XlsxWriter, typing_extensions | MIT / BSD / HPND / PSF |
| [openpyxl](https://foss.heptapod.net/openpyxl/openpyxl) (optional, `documents`) and et_xmlfile | MIT |
