# Deliberately broken session files (C5 acceptance)

Five ways a source format changes without warning. The M1a acceptance criterion
is that **all five produce data and none fails completely** (arch 16, "M1a
acceptance additions").

| file | what was done to it | expected level |
|---|---|---|
| `01-renamed-keys.jsonl`   | `role`/`content` renamed to `speaker`/`body`     | loose |
| `02-renested.json`        | messages moved three levels deeper               | loose |
| `03-truncated.jsonl`      | file cut mid-line                                | strict (surviving lines) |
| `04-unknown-fields.jsonl` | known shape plus keys we have never seen          | strict (keys kept in raw_ext) |
| `05-alien-format.txt`     | not a conversation format at all                  | raw |

The point of the table is the last column: a format change should cost the user
tool records, not the whole batch. One empty capture is enough for someone to
stop running the Skill (R17).
