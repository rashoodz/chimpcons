# @consultchimps/files

## Persistent file operations

`openRandomAccessSource` provides bounded reads and `verifyUnchanged` source
checks. `createScratchDirectory` owns temporary random-access files and cleans
up its own directory. `planFilePublication` validates input/output collisions
and captures the destination state; `publishStagedFile` publishes a separately
written file after checking that state.

Creating a new destination uses an exclusive link and refuses a concurrent
creation. Explicit replacement requires exclusive ownership of the destination
directory entry until publication finishes. The state check detects changes
observed before replacement, but portable Node filesystem APIs do not provide an
atomic compare-and-replace operation against an unrelated writer. Choose a new
output filename when another process may replace the same destination.

See the
[library guide](https://consultchimps.github.io/consultchimps/docs/libraries/).
