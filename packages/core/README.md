# @consultchimps/core

## Random-access byte contracts

`RandomAccessSource` exposes a name, byte size, and bounded asynchronous
`readAt`. `RandomAccessFile` adds writes, truncation, and explicit close. These
contracts let workbook and database operations use filesystem or browser storage
without importing either runtime into the shared operation layer.

See the
[library guide](https://consultchimps.github.io/consultchimps/docs/libraries/).
