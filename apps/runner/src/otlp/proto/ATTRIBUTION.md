# Attribution

`logs.json` is a [protobufjs](https://github.com/protobufjs/protobuf.js) JSON
descriptor generated from these files of the OpenTelemetry protocol
definitions:

- `opentelemetry/proto/collector/logs/v1/logs_service.proto`
- `opentelemetry/proto/logs/v1/logs.proto`
- `opentelemetry/proto/common/v1/common.proto`
- `opentelemetry/proto/resource/v1/resource.proto`

| | |
|---|---|
| Source | https://github.com/open-telemetry/opentelemetry-proto |
| Tag | `v1.11.1` |
| Commit | `b3f75588eb23c5fca62264edd05d382de49beb1a` |
| Licence | Apache License 2.0 — https://github.com/open-telemetry/opentelemetry-proto/blob/v1.11.1/LICENSE |
| Copyright | The OpenTelemetry Authors |

Changes from the source: the `.proto` files were loaded with protobufjs 8.8.0
(`Root.loadSync`, `Root.toJSON`), and the language-specific file options
(`java_package`, `go_package`, `csharp_namespace`, …) were removed. Comments
were dropped. Messages, fields, field numbers and enums are unchanged.

To refresh it, load the four files at the new tag the same way, write
`toJSON()` here, and update the tag and commit above.
