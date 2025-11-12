# Changelog

## 0.0.2

- Fix jumping back from `end` to `while`/`until`/`for` when the block body contains nested loops or inline `do`.
- Expose internal block-matching helper so it can be tested outside of VS Code.
- Add automated jump regression tests (covering `while`, `until`, `for` with and without `do` keywords) and wire them into `npm run test`.

## 0.0.1

- Initial release
