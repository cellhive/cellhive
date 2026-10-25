# ADR-0024: Gói xuất/nhập nguyên một base

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §17 (thêm §17.1), §22 (S9), §23 tiêu chí 12; CONTRACTS §12 (mới); BACKLOG (task ở S9, viết sau)
- Cập nhật: ADR-0037 (sửa đổi 2026-10-25, T804) — đuôi tệp gói là `.chbase`; đuôi cũ không được nhận khi nhập; `format` trong manifest (`cellhive-base`) không đổi.

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
