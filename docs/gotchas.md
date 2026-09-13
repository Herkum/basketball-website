# Known gotchas (already fixed, but easy to reintroduce)

- **Every drag-reorderable section's edit must echo back `order`**: every
  list Lambda (`content_blocks`, `coaches`, `rosters`, `contacts`,
  `sponsors`, `albums`, `photos`) does `body.setdefault("order",
  int(time.time() * 1000))` when `order` is missing from the request —
  correct for a brand new item (append to the end), wrong for an edit.
  This actually happened to the "Home" Content Block (it silently jumped
  to the bottom of the sidebar after an unrelated body-text edit) back
  when every section had its own hand-rolled submit handler and one of
  them forgot to carry `order` forward. Now that every section goes
  through `renderGenericSection`'s generic engine (`frontend/admin/app.js`),
  this is fixed in exactly one place — `openEdit()` always saves
  `{...values, order: item.order}` — so no new section can reintroduce
  this bug by forgetting it locally. Only touch that line with care.
- **API Gateway CORS + `ANY` routes**: HTTP API's automatic CORS handling for
  `OPTIONS` preflight only works if no explicit route swallows `OPTIONS`.
  Routes must be declared per real method (GET/POST/PUT/DELETE), never `ANY`.
- **S3 presigned URLs need explicit region + SigV4**: `boto3.client("s3")`
  without `region_name` signs against S3's global endpoint, which
  307-redirects buckets outside `us-east-1` to their regional endpoint — a
  redirect a browser can't follow on a signed `PUT` (signature won't match
  the new host). Always construct the uploads Lambda's S3 client with
  `region_name=os.environ["AWS_REGION"]` and
  `Config(signature_version="s3v4")`.
- **`[hidden]` attribute vs. author CSS**: an author stylesheet rule like
  `.foo { display: flex }` beats the browser's default `[hidden] {
  display: none }` at equal specificity (author origin always wins over
  user-agent origin). `frontend/admin/style.css` has a blanket
  `[hidden] { display: none !important; }` rule to guard against this —
  don't remove it.
- **`<label>` wrapping a form control it isn't meant to submit**: a `<label>`
  forwards any click inside it to its associated form control. A `file`-type
  field's drop zone (`buildFileField` in `app.js`) wraps a thumbnail AND a
  hidden file input — it's built as a plain `<div class="ad-file-drop">`
  with a `<span>` thumbnail, not a `<label>`, precisely so interacting with
  the thumbnail or crop dialog never reopens the native file picker.
- **Canvas/pointer dragging**: use Pointer Events (`pointerdown`/
  `setPointerCapture`) on the element itself, not `mousedown` + `window`-
  level `mousemove`/`mouseup` — the latter is more prone to "losing" the
  drag. `openImageCropDialog()`'s crop frame in `app.js` follows this.
- **Never use `alert()`/`confirm()`/`prompt()` in the admin UI**: these block
  the whole tab, including for browser automation tools. The admin's
  `openConfirm()` dialog and inline `dialog-error`/field-level error text
  replace every native browser prompt.
