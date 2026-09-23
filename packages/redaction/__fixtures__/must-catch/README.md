# must-catch red team fixtures

Every file here contains a **fake** credential in a real shape. The suite in
`../../src/redaction.spec.ts` asserts that none of the marked values survives
redaction, in either profile, and **with `--no-redact` set** -- hard rules are
not reachable from that flag (C6).

One miss fails CI. The plan calls the cost of an accidentally uploaded key
asymmetric; an asymmetric risk gets an asymmetric gate (arch 14).

Format: `SECRET:` lines list the exact substrings that must not appear in the
output. Everything else is context, and context is allowed to survive.

`{{}}` inside a value is removed by the loader before the test runs. It
exists so the file on disk never holds a complete token: GitHub push
protection (and the Slack/Stripe partner scanners) match the literal
shape and would block or report the public source mirror, even though
every value here is fake. The engine still sees the real shape.
