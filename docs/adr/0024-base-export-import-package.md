# ADR-0024: Gói xuất/nhập nguyên một base

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §17 (thêm §17.1), §22 (S9), §23 tiêu chí 12; CONTRACTS §12 (mới); BACKLOG (task ở S9, viết sau)
- Cập nhật: ADR-0037 (sửa đổi 2026-10-25, T804) — đuôi tệp gói là `.chbase`; đuôi cũ không được nhận khi nhập; `format` trong manifest (`cellhive-base`) không đổi.
- Sửa đổi (2026-11-08, T1016): định dạng v1 đầy đủ (view dùng chung, ảnh bìa form, ảnh thư, `detached`, `missing_ids`), người dùng theo email ở mọi chỗ, không xuất giá trị computed, có xuất giá trị field AI, base dựng ẩn + purge khi lỗi, nạp record không phải mutation của người dùng, trần gói theo env `BASE_PACKAGE_MAX_BYTES`, CLI, scope API token, đọc gói không tin cậy — xem mục "Sửa đổi 2026-11 (T1016)" cuối ADR. Định dạng: CONTRACTS §12.2, §6; SPEC §17.1, §20.

## Bối cảnh

Tiêu chí nghiệm thu MVP số 12 yêu cầu "xuất toàn bộ một base (schema + dữ liệu + file) thành một gói và nhập lại vào instance khác". Đây cũng là cam kết "không lock-in" ở SPEC §1. Nhưng SPEC v1.2 chưa mô tả định dạng gói, cách ánh xạ ID, xử lý user, secret, automation, và chưa xếp vào sprint nào.

`pg_dump` không dùng được cho việc này: nó dump cả instance, không lọc theo base/tenant, và không đổi ID khi nhập vào instance đã có dữ liệu.

## Quyết định

### 1. Định dạng gói `.chbase` (zip, UTF-8)

```text
manifest.json              { format: "cellhive-base", format_version: 1, app_version, exported_at, exported_by,
                             base: { id, name }, counts: { tables, fields, records, attachments }, checksums: { "<path>": "sha256" } }
schema/base.json           tên, icon, mô tả, settings (collation, timezone)
schema/tables.json         table + field (type, options, is_primary, required, unique_values, position), view, formula đã lưu dạng ID
schema/dashboards.json     dashboard + widget
schema/automations.json    definition (secret_id bị xoá, xem mục 3)
schema/roles.json          role custom + config (KHÔNG kèm người được gán)
data/<tbl_id>.ndjson       mỗi dòng: { "id", "created_at", "updated_at", "created_by_email", "auto": <__auto>, "fields": { "<fld_id>": <giá trị dạng lưu trữ> } }
links/<fld_id>.ndjson      { "a", "b", "position" }
files/attachments.json     { id, filename, mime, size, sha256, table_id, record_id, field_id }
files/<att_id>             nội dung file
```

- Giá trị ô ở **dạng lưu trữ** (option id, user id → email, record id), giống `meta.events.changes`.
- Không xuất: record trong thùng rác, audit log, lịch sử, event, automation run, share link, API token, secret, thành viên và việc gán role.
- File lớn: ghi zip dạng stream, không giữ toàn bộ trong RAM. Không giới hạn kích thước trong MVP, nhưng job báo tiến độ.

### 2. Nhập vào instance khác (hoặc cùng instance)

1. Kiểm `format` và `format_version` (chỉ nhận cùng major), `checksums` sha256; sai → dừng, không ghi gì.
2. Tạo base mới trong workspace đích. **Mọi ID được sinh mới**; lập bảng ánh xạ `old_id → new_id` cho table, field, option, view, dashboard, widget, automation, role, record, attachment.
3. Viết lại mọi tham chiếu qua bảng ánh xạ: formula (`[fld_…]`), filter DSL, lookup, view config, widget config, automation definition, role config, `symmetric_field_id`.
4. Tạo table/field qua `SchemaService` (quy tắc vàng #1). Nạp record theo batch 5.000 qua đường nạp hàng loạt của `RecordMutationService`, bỏ qua validate lặp nhưng vẫn kiểm type. Giữ nguyên `created_at`/`updated_at`; `__auto` giữ thứ tự tương đối. Sau cùng backfill computed field.
5. User: ánh xạ theo email với thành viên của org đích; không khớp → giá trị user thành rỗng, người tạo thành `null`. Báo cáo liệt kê email không khớp.
6. Automation nhập ở trạng thái **tắt**, `secret_id` bị bỏ; người nhập phải gắn lại secret rồi mới bật được.
7. Role custom được tạo nhưng không gán ai. Người nhập trở thành owner của base mới.
8. File: upload lại vào storage đích với key mới `{organization_id}/{new_att_id}`, kiểm sha256.
9. Toàn bộ chạy như một job (`meta.jobs`), báo tiến độ qua `user:{id}`. Lỗi giữa chừng → xoá base đang dựng dở (DDL + meta + object), không để lại rác.

### 3. Quyền và bảo mật

- Xuất: chỉ base owner / role `admin` (vì gói chứa mọi field, kể cả field bị ẩn với role khác). Audit `base.exported` kèm số lượng.
- Nhập: người có quyền tạo base trong workspace đích. Audit `base.imported`.
- Không bao giờ đưa secret, token, hash mật khẩu, IP vào gói.
- Gói là file zip do người dùng cung cấp: giải nén dạng stream với giới hạn (tổng dung lượng giải nén ≤ 20 × kích thước zip, tối đa 100.000 file, đường dẫn không chứa `..` hay đường dẫn tuyệt đối) để chống zip bomb và path traversal.

### 4. API (định dạng ở CONTRACTS §12)

```text
POST /api/v1/bases/:id/export                 → 202 { job_id }; xong → result.download_url (ký, hết hạn 1 giờ)
POST /api/v1/workspaces/:id/bases/import      multipart file .chbase → 202 { job_id }; xong → result { base_id, report }
```

## Phương án đã cân nhắc

| Phương án | Kết luận |
|---|---|
| `pg_dump` theo schema | Loại: không lọc theo base/tenant, trùng ID khi nhập vào instance đã có dữ liệu |
| Xuất CSV từng bảng | Loại: mất schema, link, formula, view, file |
| Giữ nguyên ID khi nhập | Loại: xung đột khi nhập hai lần hoặc nhập lại vào instance gốc |
| Gói zip + manifest + NDJSON + đổi ID | **Chọn** |

## Hệ quả

- Làm ở **S9** (cần đủ field type, link, formula, automation, dashboard). Test bắt buộc: xuất base mẫu `seed:demo` → nhập vào instance mới → so sánh số lượng, giá trị từng ô, kết quả formula, link hai chiều, file sha256.
- `format_version` tăng khi đổi định dạng không tương thích; bản mới phải nhập được gói của các `format_version` cũ cùng major.

## Sửa đổi 2026-11 (T1016)

Áp cho §1–§4; nội dung đã Accepted ở trên giữ nguyên trừ chỗ mục này thay. Định dạng chi tiết (entry, trường, mã lỗi, trần, route, báo cáo) ở CONTRACTS §12.2; zod của API ở `packages/contracts/src/base-packages.ts`, của gói ở `packages/server-core/src/base-package/manifest.ts`.

### 1. Định dạng `format_version: 1`

```text
manifest.json              { format: "cellhive-base", format_version: 1, app_version, exported_at, exported_by_email,
                             base: { id, name }, counts: { tables, fields, records, links, attachments, views,
                             dashboards, widgets, automations, roles }, skipped: { personal_views },
                             checksums: { "<entry>": "<sha256 hex>" } }      — ghi cuối, liệt kê mọi entry khác
schema/base.json           { name, description, icon, settings, missing_ids }
schema/tables.json         { tables: [{ id, name, description, position, primary_field_id,
                             fields: [{ id, name, type, options, is_primary, required, unique_values, description,
                                        position, link_side, result_type }] }] }
schema/views.json          { views: [{ id, table_id, type, name, position, locked, config }] }   — chỉ view dùng chung
schema/dashboards.json     { dashboards: [{ id, name, icon, description, theme, global_filters, position,
                             widgets: [{ id, type, title, config, layout }] }] }
schema/automations.json    { automations: [{ id, name, description, definition, detached: [{ path, kind, name }] }] }
schema/roles.json          { roles: [{ id, name, position, config }] }                          — chỉ role custom
data/<tbl_id>.ndjson       { id, created_at, updated_at, created_by_email, updated_by_email, auto, parent_id?, fields }
links/<fld_id>.ndjson      { a, b, position }                       — một tệp mỗi cặp link, theo field phía `a`
files/attachments.json     { files: [{ id, kind: cell | form_cover | email_asset, filename, mime, size, sha256, … }] }
files/<att_id>             nội dung tệp
```

- **Bổ sung so với §1**: view dùng chung (`schema/views.json`, tách khỏi `tables.json`) — **không** xuất view cá nhân (dữ liệu của một người, chủ của nó có thể không có ở instance đích), manifest đếm `skipped.personal_views` và báo cáo nhập lặp lại số này; ảnh bìa form (`files/attachments.json` `kind = form_cover`, theo `config.form.cover_attachment_id`) và ảnh trong thân thư automation (`kind = email_asset`, theo `asset:att_…` của `send_email`); `detached` của mỗi automation; `missing_ids` của base.
- Mọi object strict: khoá không biết → nhập từ chối. Giá trị ô, `options`, `config`, `definition` ở **dạng lưu** của base nguồn (id của gói, formula `[fld_…]`, prompt AI `{{ [fld_…] }}`).
- **Không xuất giá trị computed** (formula, lookup — nhập tính lại theo thứ tự topo rồi `computed.backfill`), link (ở `links/`), `parent` (ở `parent_id`), button, field hệ thống (thời gian/người ở cột riêng của dòng). **Có xuất giá trị field AI** (là giá trị ô text/select; sinh lại tốn quota và cho kết quả khác) — nhập giữ `options.ai`, không xếp hàng sinh.
- Ngoài danh sách không xuất của §1: theo dõi record, hàng đợi computed/AI, idempotency, con trỏ nhắc hạn/quét thời gian, ảnh chữ ký của danh tính gửi.
- **`missing_ids`**: id mà schema nêu nhưng gói không chứa (field/table trong thùng rác, option đã xoá, record trong thùng rác…). Ở chỗ bỏ được mà nghĩa không đổi (điều kiện filter của view/màu/widget — truy vấn vốn bỏ qua field đã xoá —, mục của danh sách, khoá của map) bên xuất bỏ tham chiếu; ở chỗ khác (formula, lookup, link, rule của role, điều kiện automation, widget) giữ id và ghi vào `missing_ids`. Bên nhập cấp cho mỗi id này một id mới không trỏ tới gì, nên tham chiếu vẫn hỏng như ở base nguồn (`#REF`, widget `broken`). Id không có trong gói lẫn `missing_ids` → `INVALID_PACKAGE` `DANGLING_REFERENCE`.
- Option select ánh xạ **theo field** (id option có thể trùng giữa hai field — field tạo với id option có sẵn giữ id đó); toán hạng option của filter theo field select mà điều kiện (hoặc lookup của nó) đọc.

### 2. Người dùng theo email ở mọi chỗ

- Gói **không bao giờ** chứa id user: ô user, người tạo/sửa record, `default_value` của field user, người nhận nhắc hạn, user trong Filter DSL (view, màu, role, widget, link, lookup, automation), giá trị filter control `user`, khoá màu theo user của widget, `send_notification.user_ids`, giá trị automation ghi vào field user — mỗi chỗ là email, thay đúng vị trí id. User nguồn không còn → email giữ chỗ `unknown-<n>@cellhive.invalid` (một mỗi id, miền dành riêng RFC 2606).
- Nhập chỉ ánh xạ email (không phân biệt hoa thường, như `citext`) với **thành viên của org đích** — không tra bảng user toàn cục (không lộ người tồn tại ở org khác). Email không khớp:
  - chỗ là **giá trị** (ô user, người tạo/sửa → `null`, `default_value`, người nhận nhắc hạn, giá trị automation ghi): bỏ; nhắc hạn không còn ai → tắt (`reminder: null`);
  - chỗ là **tham chiếu** (filter, người nhận thông báo, filter control): một id user mới không ai có, cùng một id cho mọi chỗ của cùng email — điều kiện giữ nghĩa ("người này, không có ở đây"); **không bao giờ bỏ điều kiện**, vì bỏ có thể nới rule đọc/sửa của role hay điều kiện automation.
  - Báo cáo `unmatched_user_emails` chỉ liệt kê email có trong gói (không gồm email giữ chỗ), tối đa 1.000 + `unmatched_users` tổng.
- Chỗ user của gói chứa id `usr_…` (hoặc chuỗi không phải email) → `INVALID_PACKAGE` `INVALID_ENTRY`: gói không thể gán người của instance đích.

### 3. Secret, danh tính, nhóm, webhook: `detached`

Bên xuất thay bằng `null` và liệt kê `{ path, kind, name }` (tên lúc xuất): `send_telegram.secret_id`, `http_request.auth.secret_id`/`signing_secret_id`, `run_n8n_workflow.signing_secret_id` (`secret`); `send_email.identity_id` (về người gửi hệ thống) và `reply_to` kiểu danh tính (về mặc định) (`email_identity`); recipient `group_id` của `send_notification` (`group`); trigger `webhook.received.incoming_webhook_id` (`incoming_webhook` — hook là secret). Bên nhập **luôn** để các chỗ đó `null`, bất kể gói ghi gì (không bao giờ mang id của org đích vào), giữ tên đã liệt kê cho báo cáo `secrets_to_reconnect` / `webhooks_to_recreate`. Automation nhập ở trạng thái tắt, `run_as` = `created_by` = người nhập; bật khi chưa gắn lại → `422 AUTOMATION_INVALID` như hiện có.

### 4. Nhập: base ẩn, purge, nạp không event

- Base dựng ở trạng thái **ẩn** (`meta.bases.import_job_id` + `deleted_at` lúc tạo — base xoá mềm vốn `404` mọi đường; không trong danh sách/thùng rác base); lỗi, huỷ, worker chết, lần thử lại → `purgeBase` (drop `data.*` + junction, xoá meta, xoá object đã ghi; chỉ cho base có `import_job_id` khớp job) rồi `failed` — **không** tiếp tục nhập dở; hoàn tất trong một transaction (bỏ ẩn, người nhập là owner duy nhất, audit `base.imported` + `base.created`, job `succeeded`). Thay §2.9.
- Lượt 1 kiểm toàn bộ gói trước khi ghi gì: cấu trúc, trần, sha256 mọi entry, zod mọi entry JSON, bảng ánh xạ, viết lại tham chiếu "khô".
- **Nạp record từ gói không phải mutation của người dùng** (thay §2.4): `RecordMutationService.loadPackageBatch` (một cửa — quy tắc vàng #1) giữ `created_at`/`updated_at`, người tạo/sửa theo email, `__auto` (thứ tự tương đối) và giá trị `auto_number`; kiểm kiểu từng ô bằng parser của field-types; **không** event, audit theo record, theo dõi, thông báo, hàng đợi AI/computed — một audit `base.imported` (số lượng, không giá trị) thay thế.
- Tệp: sha256 và MIME tính lại; danh sách chặn mặc định `ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS` **luôn** áp (field của gói không nới được); tệp bị chặn, quá `ATTACHMENT_MAX_FILE_BYTES` hay nội dung không đúng loại → bỏ khỏi ô, báo cáo `files_skipped`; sha256 lệch manifest → `INVALID_PACKAGE`.

### 5. Trần, CLI, quyền, scope

- Thay "Không giới hạn kích thước trong MVP" (§1) và trần của §3: gói ≤ `BASE_PACKAGE_MAX_BYTES` (env, mặc định 2 GiB, 1 MiB…5 GiB − 1 — gói spool ra tệp tạm của worker rồi lưu bằng một S3 PUT ≤ 5 GB); tổng không nén ≤ min(20 × gói, 4 × `BASE_PACKAGE_MAX_BYTES`); ≤ 100.000 entry; entry JSON ≤ 64 MiB; dòng NDJSON ≤ 16 MiB; độ sâu JSON ≤ 64. Writer áp đúng các trần đó (xuất không bao giờ tạo gói mà nhập từ chối); một xuất + một nhập mỗi org chạy cùng lúc.
- Base lớn hơn hoặc chuyển instance: CLI trong container `cellhive base export --base <id> --out <tệp>` / `cellhive base import --workspace <id> --file <tệp> --as <email>` (cùng code job, không qua HTTP, trần vẫn theo env).
- Xuất: base owner/admin **hoặc org owner/admin**; nhập: quyền tạo base trong workspace đích. API token được phép: xuất `records:read` + theo request `schema:read`, `automations:read`; nhập `schema:write` + theo request `records:write`, `automations:write`; `base_ids` áp dụng. Tải như `audit.base_export`: người tạo khi vẫn là base admin, hoặc org owner/admin; token chỉ job của chính user, base trong `base_ids`.

### 6. Đọc gói không tin cậy

Không bao giờ giải nén theo tên: chỉ entry khớp allowlist (regex trên tên ASCII với id đúng dạng) được đọc, thẳng vào parser hoặc key storage mới. Trước khi đọc entry nào: `validateFileName` (`..`, đường tuyệt đối/ổ đĩa, `\`), ký tự điều khiển, thư mục, symlink và mọi loại không phải tệp thường, mã hoá, phương thức nén ngoài stored/deflate → `UNSAFE_ENTRY`; tên trùng sau chuẩn hoá NFC → `DUPLICATE_ENTRY`; hai entry chung dữ liệu, central directory/offset hỏng, cắt cụt, CRC sai → `INVALID_ARCHIVE`; trần ở central directory và lại khi giải nén (entry không bao giờ cho ra nhiều byte hơn kích thước khai báo) → `ARCHIVE_LIMIT_EXCEEDED`; zip lồng không bao giờ được mở. Mọi lời gọi `yauzl` được bọc, mọi đọc file đi qua một reader kiểm offset/độ dài trong phạm vi tệp trước khi tới `fs` — offset giả không thể ném lỗi trong callback (nơi không gì bắt được) và làm chết tiến trình. JSON parse sau khi kiểm độ sâu trên văn bản, khoá `__proto__` bị từ chối.

### Hệ quả bổ sung

- Writer dùng `yazl` (MIT, cùng tác giả `yauzl`, stream, ZIP64 tự động) — dependency mới duy nhất của S9.
- Gói không ký (chữ ký gói, tuỳ chọn "chỉ cấu trúc", tiếp tục nhập dở, S3 multipart > 5 GB, xuất theo lịch: sau v0.1).
