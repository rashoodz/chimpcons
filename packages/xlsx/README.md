# @consultchimps/xlsx

## Streaming workbook reads

The `@consultchimps/xlsx/stream` entry reads worksheet, named-table, and range
selections from random-access OOXML bytes. A shared workbook session yields
bounded row batches and uses scratch files for shared strings. It retains
numeric tokens and distinguishes formula caches, missing caches, and errors. It
reads date styles and both workbook date systems without loading the entire
worksheet into JavaScript arrays.

See the
[library guide](https://consultchimps.github.io/consultchimps/docs/libraries/).
